import { ModelScanner } from "../../../../src/intelligence/rails/scanners/model-scanner.js";
import { ModelEntity } from "../../../../src/intelligence/rails/types.js";

const USER_MODEL = [
  "class User < ApplicationRecord",
  "  include Searchable",
  "",
  "  has_many :orders, dependent: :destroy",
  '  has_many :articles, class_name: "Post", foreign_key: :author_id',
  "  has_many :teams, through: :memberships",
  "  has_one :profile",
  "  belongs_to :account, optional: true",
  "  belongs_to :owner, polymorphic: true",
  "",
  "  validates :email, presence: true, uniqueness: true",
  "  validates :name,",
  "    presence: true,",
  "    length: { maximum: 100 }",
  "  validate :custom_check",
  "",
  "  before_save :normalize_email",
  "  after_create_commit :enqueue_welcome_email",
  "",
  "  scope :active, -> { where(active: true) }",
  "",
  "  private",
  "",
  "  def normalize_email",
  "  end",
  "end",
].join("\n");

describe("ModelScanner", () => {
  const scan = (content: string, relPath = "app/models/user.rb") =>
    new ModelScanner().scan([{ relPath, content }]);

  it("extracts associations with options", () => {
    const model = scan(USER_MODEL).entities[0] as ModelEntity;

    expect(model.name).toBe("User");
    expect(model.table).toBe("users");
    const byName = Object.fromEntries(model.associations.map((a) => [a.name, a]));
    expect(byName.orders).toMatchObject({ kind: "has_many", className: "Order", dependent: "destroy" });
    expect(byName.articles.className).toBe("Post");
    expect(byName.teams.through).toBe("memberships");
    expect(byName.profile.kind).toBe("has_one");
    expect(byName.account).toMatchObject({ kind: "belongs_to", className: "Account" });
    expect(byName.owner.polymorphic).toBe(true);
  });

  it("emits association intents but skips polymorphic targets", () => {
    const intents = scan(USER_MODEL).intents.filter((i) => i.toType === "model");
    const names = intents.map((i) => i.toName);
    expect(names).toEqual(expect.arrayContaining(["Order", "Post", "Team", "Profile", "Account"]));
    expect(names).not.toContain("Owner");
  });

  it("extracts multi-line validations, callbacks, scopes, and concerns", () => {
    const model = scan(USER_MODEL).entities[0] as ModelEntity;

    expect(model.validations).toHaveLength(3);
    expect(model.validations[1].attributes).toEqual(["name"]);
    expect(model.validations[1].rules).toEqual(expect.arrayContaining(["presence", "length"]));
    expect(model.callbacks).toEqual([
      expect.objectContaining({ kind: "before_save", handler: "normalize_email" }),
      expect.objectContaining({ kind: "after_create_commit", handler: "enqueue_welcome_email" }),
    ]);
    expect(model.scopes.map((s) => s.name)).toEqual(["active"]);
    expect(model.concerns).toEqual(["Searchable"]);
  });

  it("respects self.table_name overrides", () => {
    const source = ["class Person < ApplicationRecord", '  self.table_name = "humans"', "end"].join("\n");
    const result = scan(source, "app/models/person.rb");
    expect((result.entities[0] as ModelEntity).table).toBe("humans");
    expect(result.intents.find((i) => i.relationship === "backed_by_table")?.toName).toBe("humans");
  });

  it("qualifies namespaced models", () => {
    const source = ["module Billing", "  class Invoice < ApplicationRecord", "    has_many :line_items", "  end", "end"].join("\n");
    const model = scan(source, "app/models/billing/invoice.rb").entities[0] as ModelEntity;
    expect(model.name).toBe("Billing::Invoice");
    expect(model.associations[0].className).toBe("LineItem");
  });

  it("ignores macros in comments and heredocs", () => {
    const source = [
      "class Note < ApplicationRecord",
      "  # has_many :fakes",
      "  SQL = <<~SQL",
      "    has_many :also_fake",
      "  SQL",
      "  has_many :tags",
      "end",
    ].join("\n");
    const model = scan(source, "app/models/note.rb").entities[0] as ModelEntity;
    expect(model.associations.map((a) => a.name)).toEqual(["tags"]);
  });

  it("does not match concern files", () => {
    expect(new ModelScanner().appliesTo("app/models/concerns/searchable.rb")).toBe(false);
    expect(new ModelScanner().appliesTo("app/models/user.rb")).toBe(true);
  });
});
