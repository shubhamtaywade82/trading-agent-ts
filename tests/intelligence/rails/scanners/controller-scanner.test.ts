import { ControllerScanner } from "../../../../src/intelligence/rails/scanners/controller-scanner.js";
import { ControllerEntity } from "../../../../src/intelligence/rails/types.js";

const CONTROLLER = [
  "class UsersController < ApplicationController",
  "  include Paginatable",
  "",
  "  before_action :authenticate_user!",
  "  before_action :set_user, only: %i[show activate]",
  "  before_action :log_request, except: [:index]",
  "  rescue_from ActiveRecord::RecordNotFound, with: :render_not_found",
  "",
  "  def index",
  "  end",
  "",
  "  def show",
  "  end",
  "",
  "  private",
  "",
  "  def set_user",
  "  end",
  "end",
].join("\n");

describe("ControllerScanner", () => {
  it("extracts public actions only", () => {
    const result = new ControllerScanner().scan([{ relPath: "app/controllers/users_controller.rb", content: CONTROLLER }]);
    const controller = result.entities[0] as ControllerEntity;

    expect(controller.name).toBe("UsersController");
    expect(controller.actions.map((a) => a.name)).toEqual(["index", "show"]);
  });

  it("extracts before_actions with only/except and rescue_from", () => {
    const result = new ControllerScanner().scan([{ relPath: "app/controllers/users_controller.rb", content: CONTROLLER }]);
    const controller = result.entities[0] as ControllerEntity;

    expect(controller.beforeActions).toEqual([
      expect.objectContaining({ handler: "authenticate_user!" }),
      expect.objectContaining({ handler: "set_user", only: ["show", "activate"] }),
      expect.objectContaining({ handler: "log_request", except: ["index"] }),
    ]);
    expect(controller.rescueHandlers).toEqual([
      expect.objectContaining({ exception: "ActiveRecord::RecordNotFound", handler: "render_not_found" }),
    ]);
    expect(controller.concerns).toEqual(["Paginatable"]);
  });

  it("qualifies module-nested controllers", () => {
    const source = ["module Admin", "  class ReportsController < ApplicationController", "    def index", "    end", "  end", "end"].join("\n");
    const result = new ControllerScanner().scan([{ relPath: "app/controllers/admin/reports_controller.rb", content: source }]);
    const controller = result.entities[0] as ControllerEntity;

    expect(controller.name).toBe("Admin::ReportsController");
    expect(controller.actions.map((a) => a.name)).toEqual(["index"]);
  });
});
