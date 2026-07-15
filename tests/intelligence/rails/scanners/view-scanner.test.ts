import { ViewScanner } from "../../../../src/intelligence/rails/scanners/view-scanner.js";
import { ViewEntity } from "../../../../src/intelligence/rails/types.js";

describe("ViewScanner", () => {
  // ─── ERB templates ──────────────────────────────────────────────────

  describe("ERB templates", () => {
    it("extracts controller/action from path and emits renders_view intent", () => {
      const erb = "<h1>Users</h1>\n<ul>\n<% @users.each do |u| %>\n  <li><%= u.name %></li>\n<% end %>\n</ul>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/index.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.type).toBe("view");
      expect(view.name).toBe("users/index");
      expect(view.controller).toBe("Users");
      expect(view.action).toBe("index");
      expect(view.viewFormat).toBe("erb");
      expect(view.format).toBe("html");

      expect(result.intents).toContainEqual(
        expect.objectContaining({
          relationship: "renders_view",
          toType: "controller",
          toName: "UsersController",
          meta: { action: "index" },
        }),
      );
    });

    it("extracts @instance variable model references", () => {
      const erb = "<%= @users.each do |u| %>\n<%= @user.name %>\n<%= render @posts %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/index.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.referencedModels).toEqual(
        expect.arrayContaining(["User", "Post"]),
      );

      expect(result.intents).toContainEqual(
        expect.objectContaining({ relationship: "references_model", toType: "model", toName: "User" }),
      );
    });

    it("extracts constant receiver model references (User.all, User.find)", () => {
      const erb = "<%= User.all.each do |u| %>\n<%= User.find(@user_id).name %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/index.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.referencedModels).toContain("User");
    });

    it("extracts render partial calls and emits renders_partial intents", () => {
      const erb = "<%= render partial: 'form' %>\n<%= render 'shared/header' %>\n<%= render partial: 'user', locals: { user: @user } %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/edit.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.referencedPartials).toContain("users/form");
      expect(view.referencedPartials).toContain("shared/header");
      expect(view.referencedPartials).toContain("users/user");

      expect(result.intents).toContainEqual(
        expect.objectContaining({ relationship: "renders_partial", toType: "view", toName: "users/form" }),
      );
    });

    it("extracts component references via XxxComponent.new(...)", () => {
      const erb = "<%= render UserComponent.new(user: @user) %>\n<%= render Admin::TableComponent.new(rows: @users) %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/show.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.referencedComponents).toContain("UserComponent");
      expect(view.referencedComponents).toContain("Admin::TableComponent");

      expect(result.intents).toContainEqual(
        expect.objectContaining({ relationship: "renders_component", toType: "component", toName: "UserComponent" }),
      );
    });

    it("extracts helper method usage", () => {
      const erb = "<%= link_to 'Profile', @user %>\n<%= form_with model: @user do |f| %>\n<%= button_to 'Delete', @user, method: :delete %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/show.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.referencedHelpers).toContain("link_to");
      expect(view.referencedHelpers).toContain("form_with");
      expect(view.referencedHelpers).toContain("button_to");
    });

    it("skips partial files for controller/action convention", () => {
      const erb = "<%= render 'form' %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/_form.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.controller).toBeUndefined();
      expect(view.action).toBeUndefined();
      expect(view.type).toBe("view");
    });

    it("handles JSON format response", () => {
      const erb = '<%= @user.to_json %>\n';
      const result = new ViewScanner().scan([{ relPath: "app/views/users/show.json.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.format).toBe("json");
    });

    it("deduplicates model references", () => {
      const erb = "<%= @user.name %>\n<%= @user.email %>\n<%= render @user %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/show.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      // User should appear exactly once
      const userRefs = view.referencedModels.filter((m) => m === "User");
      expect(userRefs).toHaveLength(1);
    });

    it("skips ERB comments", () => {
      const erb = "<%# this is a comment %>\n<%= @user.name %>\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/show.html.erb", content: erb }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.referencedModels).toContain("User");
    });
  });

  // ─── HAML / Slim / Builder ─────────────────────────────────────────

  describe("alternate template formats", () => {
    it("detects HAML format", () => {
      const haml = "%h1 Users\n- @users.each do |u|\n  %p= u.name\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/index.html.haml", content: haml }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.viewFormat).toBe("haml");
      expect(view.format).toBe("html");
    });

    it("detects Slim format", () => {
      const slim = "h1 Users\n- @users.each do |u|\n  p = u.name\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/index.html.slim", content: slim }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.viewFormat).toBe("slim");
    });

    it("detects Builder format", () => {
      const builder = "xml.instruct!\nxml.users do\n  @users.each do |u|\n    xml.user u.name\n  end\nend\n";
      const result = new ViewScanner().scan([{ relPath: "app/views/users/index.xml.builder", content: builder }]);
      const view = result.entities[0] as ViewEntity;

      expect(view.viewFormat).toBe("builder");
      expect(view.format).toBe("xml");
    });
  });

  // ─── Layouts ────────────────────────────────────────────────────────

  it("does not extract controller/action for layouts", () => {
    const erb = "<%= yield %>\n";
    const result = new ViewScanner().scan([{ relPath: "app/views/layouts/application.html.erb", content: erb }]);
    const view = result.entities[0] as ViewEntity;

    expect(view.controller).toBeUndefined();
    expect(view.action).toBeUndefined();
  });

  // ─── Namespaced controllers ─────────────────────────────────────────

  it("handles namespaced controller paths", () => {
    const erb = "<%= @users.each do |u| %>\n<% end %>\n";
    const result = new ViewScanner().scan([{ relPath: "app/views/admin/users/index.html.erb", content: erb }]);
    const view = result.entities[0] as ViewEntity;

    expect(view.controller).toBe("Admin::Users");
    expect(view.action).toBe("index");
  });

  // ─── ViewComponent .rb files ────────────────────────────────────────

  describe("ViewComponent .rb files", () => {
    it("detects ViewComponent::Base subclass", () => {
      const rb = [
        "class UserComponent < ViewComponent::Base",
        "  def initialize(user:)",
        "    @user = user",
        "  end",
        "",
        "  def render?",
        "    @user.present?",
        "  end",
        "end",
      ].join("\n");

      const result = new ViewScanner().scan([{ relPath: "app/components/user_component.rb", content: rb }]);
      const component = result.entities[0] as ViewEntity;

      expect(component.type).toBe("component");
      expect(component.name).toBe("UserComponent");
      expect(component.viewFormat).toBe("view_component");
      expect(component.componentClass).toBe("UserComponent");
      expect(component.template).toBe("app/components/user_component.html.erb");
      expect(component.referencedModels).toContain("User");

      expect(result.intents).toContainEqual(
        expect.objectContaining({ relationship: "references_model", toType: "model", toName: "User" }),
      );
    });

    it("detects ApplicationComponent subclass", () => {
      const rb = [
        "class TableComponent < ApplicationComponent",
        "  def initialize(rows:)",
        "    @rows = rows",
        "  end",
        "end",
      ].join("\n");

      const result = new ViewScanner().scan([{ relPath: "app/components/table_component.rb", content: rb }]);
      const component = result.entities[0] as ViewEntity;

      expect(component.name).toBe("TableComponent");
      expect(component.viewFormat).toBe("view_component");
    });

    it("handles namespaced components", () => {
      const rb = [
        "module Admin",
        "  class UserRowComponent < ViewComponent::Base",
        "    def initialize(user:)",
        "      @user = user",
        "    end",
        "  end",
        "end",
      ].join("\n");

      const result = new ViewScanner().scan([{ relPath: "app/components/admin/user_row_component.rb", content: rb }]);
      const component = result.entities[0] as ViewEntity;

      expect(component.name).toBe("Admin::UserRowComponent");
      // Model derived from class name after namespace prefix
      expect(component.referencedModels).toContain("Admin::UserRow");
    });
  });

  // ─── Phlex .rb files ────────────────────────────────────────────────

  describe("Phlex .rb files", () => {
    it("detects Phlex::HTML subclass", () => {
      const rb = [
        "class ProfileCard < Phlex::HTML",
        "  def initialize(user:)",
        "    @user = user",
        "  end",
        "",
        "  def view_template",
        "    h1 { @user.name }",
        "  end",
        "end",
      ].join("\n");

      const result = new ViewScanner().scan([{ relPath: "app/components/profile_card.rb", content: rb }]);
      const component = result.entities[0] as ViewEntity;

      expect(component.type).toBe("component");
      expect(component.name).toBe("ProfileCard");
      expect(component.viewFormat).toBe("phlex");
      expect(component.componentClass).toBe("ProfileCard");
      // No "Component" suffix, so no model is derived by convention
      expect(component.referencedModels).toEqual([]);
    });
  });

  // ─── Non-matching paths ─────────────────────────────────────────────

  describe("appliesTo", () => {
    it("returns true for ERB in app/views", () => {
      expect(new ViewScanner().appliesTo("app/views/users/index.html.erb")).toBe(true);
    });

    it("returns true for HAML in app/views", () => {
      expect(new ViewScanner().appliesTo("app/views/users/index.html.haml")).toBe(true);
    });

    it("returns true for .rb in app/components", () => {
      expect(new ViewScanner().appliesTo("app/components/user_component.rb")).toBe(true);
    });

    it("returns false for .rb in app/models", () => {
      expect(new ViewScanner().appliesTo("app/models/user.rb")).toBe(false);
    });

    it("returns false for non-view files", () => {
      expect(new ViewScanner().appliesTo("app/controllers/users_controller.rb")).toBe(false);
    });

    it("returns false for files outside app/views and app/components", () => {
      expect(new ViewScanner().appliesTo("lib/something.rb")).toBe(false);
    });
  });
});
