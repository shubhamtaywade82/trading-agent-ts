import { ConcernScanner } from "../../../../src/intelligence/rails/scanners/concern-scanner.js";
import { JobScanner } from "../../../../src/intelligence/rails/scanners/job-scanner.js";
import { MailerScanner } from "../../../../src/intelligence/rails/scanners/mailer-scanner.js";
import { MigrationScanner } from "../../../../src/intelligence/rails/scanners/migration-scanner.js";
import { PolicyScanner } from "../../../../src/intelligence/rails/scanners/policy-scanner.js";
import { RspecScanner } from "../../../../src/intelligence/rails/scanners/rspec-scanner.js";
import { ServiceScanner } from "../../../../src/intelligence/rails/scanners/service-scanner.js";
import {
  ConcernEntity,
  JobEntity,
  MailerEntity,
  MigrationEntity,
  PolicyEntity,
  ServiceEntity,
  SpecEntity,
} from "../../../../src/intelligence/rails/types.js";

describe("ServiceScanner", () => {
  const SOURCE = [
    "class UserCreator",
    "  def self.call(params)",
    "    new(params).call",
    "  end",
    "",
    "  def call",
    "    user = User.create!(@params)",
    "    WelcomeEmailJob.perform_later(user.id)",
    "    UserMailer.welcome(user).deliver_later",
    "    NotifySlack.call(user)",
    "    user",
    "  end",
    "",
    "  private",
    "",
    "  def audit!",
    "  end",
    "end",
  ].join("\n");

  it("extracts public methods and call interface", () => {
    const result = new ServiceScanner().scan([{ relPath: "app/services/user_creator.rb", content: SOURCE }]);
    const service = result.entities[0] as ServiceEntity;

    expect(service.name).toBe("UserCreator");
    expect(service.publicMethods).toEqual(["call", "call"]);
    expect(service.hasCallInterface).toBe(true);
  });

  it("emits calls/enqueues/delivers intents", () => {
    const intents = new ServiceScanner().scan([{ relPath: "app/services/user_creator.rb", content: SOURCE }]).intents;
    expect(intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship: "calls", toType: "model", toName: "User" }),
        expect.objectContaining({ relationship: "enqueues", toType: "job", toName: "WelcomeEmailJob" }),
        expect.objectContaining({ relationship: "delivers", toType: "mailer", toName: "UserMailer" }),
        expect.objectContaining({ relationship: "calls", toType: "service", toName: "NotifySlack" }),
      ]),
    );
  });
});

describe("JobScanner", () => {
  const SOURCE = [
    "class WelcomeEmailJob < ApplicationJob",
    "  queue_as :mailers",
    "",
    "  def perform(user_id, force: false)",
    "    user = User.find(user_id)",
    "    UserMailer.welcome(user).deliver_now",
    "  end",
    "end",
  ].join("\n");

  it("extracts queue, perform args, and references", () => {
    const result = new JobScanner().scan([{ relPath: "app/jobs/welcome_email_job.rb", content: SOURCE }]);
    const job = result.entities[0] as JobEntity;

    expect(job.name).toBe("WelcomeEmailJob");
    expect(job.queue).toBe("mailers");
    expect(job.performArgs).toEqual(["user_id", "force: false"]);
    expect(result.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship: "calls", toName: "User" }),
        expect.objectContaining({ relationship: "delivers", toName: "UserMailer" }),
      ]),
    );
  });
});

describe("MailerScanner", () => {
  it("extracts actions and default from", () => {
    const source = [
      "class UserMailer < ApplicationMailer",
      '  default from: "hello@example.com"',
      "",
      "  def welcome(user)",
      "  end",
      "",
      "  def goodbye(user)",
      "  end",
      "",
      "  private",
      "",
      "  def helper",
      "  end",
      "end",
    ].join("\n");
    const mailer = new MailerScanner().scan([{ relPath: "app/mailers/user_mailer.rb", content: source }])
      .entities[0] as MailerEntity;

    expect(mailer.actions).toEqual(["welcome", "goodbye"]);
    expect(mailer.defaultFrom).toBe("hello@example.com");
  });
});

describe("PolicyScanner", () => {
  it("extracts permissions and authorizes intent", () => {
    const source = ["class UserPolicy < ApplicationPolicy", "  def show?", "    true", "  end", "  def update?", "    false", "  end", "end"].join("\n");
    const result = new PolicyScanner().scan([{ relPath: "app/policies/user_policy.rb", content: source }]);
    const policy = result.entities[0] as PolicyEntity;

    expect(policy.permissions).toEqual(["show?", "update?"]);
    expect(result.intents[0]).toMatchObject({ relationship: "authorizes", toType: "model", toName: "User" });
  });
});

describe("ConcernScanner", () => {
  it("extracts concern modules and tracked macros", () => {
    const source = [
      "module Searchable",
      "  extend ActiveSupport::Concern",
      "",
      "  included do",
      '    scope :search, ->(term) { where("name ILIKE ?", term) }',
      "  end",
      "end",
    ].join("\n");
    const concern = new ConcernScanner().scan([{ relPath: "app/models/concerns/searchable.rb", content: source }])
      .entities[0] as ConcernEntity;

    expect(concern.name).toBe("Searchable");
    expect(concern.macros.some((m) => m.startsWith("scope :search"))).toBe(true);
  });
});

describe("RspecScanner", () => {
  it("extracts subject, type, and example count", () => {
    const source = [
      'require "rails_helper"',
      "",
      "RSpec.describe User, type: :model do",
      '  it "does a thing" do',
      "  end",
      '  it "does another" do',
      "  end",
      "end",
    ].join("\n");
    const result = new RspecScanner().scan([{ relPath: "spec/models/user_spec.rb", content: source }]);
    const spec = result.entities[0] as SpecEntity;

    expect(spec.subjectName).toBe("User");
    expect(spec.specType).toBe("model");
    expect(spec.exampleCount).toBe(2);
    expect(result.intents[0]).toMatchObject({ relationship: "tested_by", toType: "model", toName: "User" });
  });

  it("infers request specs from path with string subjects", () => {
    const source = ['RSpec.describe "Users", type: :request do', '  it "lists" do', "  end", "end"].join("\n");
    const result = new RspecScanner().scan([{ relPath: "spec/requests/users_spec.rb", content: source }]);
    const spec = result.entities[0] as SpecEntity;

    expect(spec.specType).toBe("request");
    expect(spec.subjectName).toBe("Users");
    expect(result.intents).toHaveLength(0); // string subject on a request spec is not linkable
  });
});

describe("MigrationScanner", () => {
  it("extracts timestamp, operations, and table intents", () => {
    const source = [
      "class CreateUsers < ActiveRecord::Migration[7.1]",
      "  def change",
      "    create_table :users do |t|",
      "      t.string :email",
      "    end",
      "    add_index :users, :email, unique: true",
      "  end",
      "end",
    ].join("\n");
    const result = new MigrationScanner().scan([
      { relPath: "db/migrate/20240101000000_create_users.rb", content: source },
    ]);
    const migration = result.entities[0] as MigrationEntity;

    expect(migration.timestamp).toBe("20240101000000");
    expect(migration.name).toBe("create_users");
    expect(migration.operations).toEqual(["create_table", "add_index"]);
    expect(result.intents[0]).toMatchObject({ relationship: "defined_in_migration", toType: "table", toName: "users" });
  });
});
