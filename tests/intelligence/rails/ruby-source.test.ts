import {
  camelize,
  classify,
  logicalLines,
  parseMacroArgs,
  parseSymbolList,
  singularize,
  stripComment,
  underscore,
} from "../../../src/intelligence/rails/scanners/ruby-source.js";

describe("ruby-source", () => {
  describe("stripComment", () => {
    it("removes trailing comments", () => {
      expect(stripComment("has_many :posts # user posts")).toBe("has_many :posts ");
    });

    it("keeps # inside strings", () => {
      expect(stripComment('scope :tagged, -> { where("name LIKE \'#a\'") }')).toContain("#a");
    });
  });

  describe("logicalLines", () => {
    it("tracks class namespaces and depth", () => {
      const lines = logicalLines(
        [
          "module Admin",
          "  class UsersController < ApplicationController",
          "    def index",
          "    end",
          "  end",
          "end",
        ].join("\n"),
      );
      const def = lines.find((l) => l.text.startsWith("def index"));
      expect(def?.namespace).toEqual(["Admin", "UsersController"]);
      expect(def?.depth).toBe(2);
    });

    it("joins continuation lines ending in a comma", () => {
      const lines = logicalLines(["validates :email,", "  presence: true,", "  uniqueness: true"].join("\n"));
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toBe("validates :email, presence: true, uniqueness: true");
      expect(lines[0].line).toBe(1);
    });

    it("joins continuation lines with unbalanced brackets", () => {
      const lines = logicalLines(["scope :active, -> {", "  where(active: true)", "}"].join("\n"));
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toContain("where(active: true)");
    });

    it("skips heredoc bodies", () => {
      const lines = logicalLines(
        ["sql = <<~SQL", "  SELECT * FROM users -- has_many :fake", "SQL", "has_many :posts"].join("\n"),
      );
      const texts = lines.map((l) => l.text);
      expect(texts.some((t) => t.includes("SELECT"))).toBe(false);
      expect(texts).toContain("has_many :posts");
    });

    it("does not treat trailing-if modifiers as block openers", () => {
      const lines = logicalLines(["class Foo", "  validate :bar if Rails.env.test?", "  def baz", "  end", "end"].join("\n"));
      const def = lines.find((l) => l.text.startsWith("def baz"));
      expect(def?.namespace).toEqual(["Foo"]);
      expect(def?.depth).toBe(1);
    });
  });

  describe("parseMacroArgs", () => {
    it("parses positional symbols and options", () => {
      const call = parseMacroArgs(':posts, class_name: "Article", dependent: :destroy');
      expect(call.args).toEqual(["posts"]);
      expect(call.opts.class_name).toBe('"Article"');
      expect(call.opts.dependent).toBe(":destroy");
    });

    it("ignores commas inside nested brackets", () => {
      const call = parseMacroArgs(":email, format: { with: /a,b/, message: \"bad\" }, presence: true");
      expect(call.args).toEqual(["email"]);
      expect(call.opts.presence).toBe("true");
      expect(call.opts.format).toContain("message");
    });
  });

  describe("parseSymbolList", () => {
    it("parses %i arrays", () => {
      expect(parseSymbolList("%i[show edit]")).toEqual(["show", "edit"]);
    });
    it("parses bracket arrays", () => {
      expect(parseSymbolList("[:show, :edit]")).toEqual(["show", "edit"]);
    });
    it("parses single symbols", () => {
      expect(parseSymbolList(":show")).toEqual(["show"]);
    });
  });

  describe("inflection", () => {
    it("singularizes regular and irregular nouns", () => {
      expect(singularize("orders")).toBe("order");
      expect(singularize("categories")).toBe("category");
      expect(singularize("people")).toBe("person");
      expect(singularize("addresses")).toBe("address");
      expect(singularize("boxes")).toBe("box");
    });

    it("camelizes and underscores", () => {
      expect(camelize("admin/user_accounts")).toBe("Admin::UserAccounts");
      expect(underscore("Admin::UserAccount")).toBe("admin/user_account");
    });

    it("classifies association names", () => {
      expect(classify("orders", "has_many")).toBe("Order");
      expect(classify("account", "belongs_to")).toBe("Account");
      expect(classify("profile", "has_one")).toBe("Profile");
    });
  });
});
