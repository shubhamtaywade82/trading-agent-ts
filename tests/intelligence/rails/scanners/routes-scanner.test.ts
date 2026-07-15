import { RoutesScanner } from "../../../../src/intelligence/rails/scanners/routes-scanner.js";
import { RouteEntity } from "../../../../src/intelligence/rails/types.js";

function scan(lines: string[]): RouteEntity[] {
  const content = ["Rails.application.routes.draw do", ...lines.map((l) => `  ${l}`), "end"].join("\n");
  return new RoutesScanner().scan([{ relPath: "config/routes.rb", content }]).entities as RouteEntity[];
}

function route(routes: RouteEntity[], verb: string, path: string): RouteEntity | undefined {
  return routes.find((r) => r.verb === verb && r.path === path);
}

describe("RoutesScanner", () => {
  it("expands resources into RESTful routes", () => {
    const routes = scan(["resources :users"]);
    expect(routes).toHaveLength(7);
    expect(route(routes, "GET", "/users")).toMatchObject({ controller: "users", action: "index" });
    expect(route(routes, "POST", "/users")).toMatchObject({ action: "create" });
    expect(route(routes, "GET", "/users/:id")).toMatchObject({ action: "show" });
    expect(route(routes, "PATCH", "/users/:id")).toMatchObject({ action: "update" });
    expect(route(routes, "DELETE", "/users/:id")).toMatchObject({ action: "destroy" });
  });

  it("honors only: and except:", () => {
    expect(scan(["resources :users, only: %i[index show]"]).map((r) => r.action)).toEqual(["index", "show"]);
    const except = scan(["resources :users, except: [:destroy, :edit, :new]"]);
    expect(except.map((r) => r.action).sort()).toEqual(["create", "index", "show", "update"]);
  });

  it("handles namespaces with module prefixes", () => {
    const routes = scan(["namespace :admin do", "  resources :reports, only: [:index]", "end"]);
    expect(routes[0]).toMatchObject({ path: "/admin/reports", controller: "admin/reports", action: "index" });
  });

  it("handles member and collection blocks", () => {
    const routes = scan([
      "resources :users, only: [:show] do",
      "  member do",
      "    post :activate",
      "  end",
      "  collection do",
      "    get :search",
      "  end",
      "end",
    ]);
    expect(route(routes, "POST", "/users/:id/activate")).toMatchObject({ controller: "users", action: "activate" });
    expect(route(routes, "GET", "/users/search")).toMatchObject({ action: "search" });
  });

  it("nests resources with parent id params", () => {
    const routes = scan(["resources :users, only: [] do", "  resources :orders, only: [:index]", "end"]);
    expect(route(routes, "GET", "/users/:user_id/orders")).toMatchObject({ controller: "orders", action: "index" });
  });

  it("handles explicit verb routes, root, and singular resource", () => {
    const routes = scan([
      'root "pages#home"',
      'get "health", to: "system#health"',
      'post "/webhooks/stripe" => "webhooks#stripe"',
      "resource :profile, only: [:show]",
    ]);
    expect(route(routes, "GET", "/")).toMatchObject({ controller: "pages", action: "home" });
    expect(route(routes, "GET", "/health")).toMatchObject({ controller: "system", action: "health" });
    expect(route(routes, "POST", "/webhooks/stripe")).toMatchObject({ controller: "webhooks", action: "stripe" });
    expect(route(routes, "GET", "/profile")).toMatchObject({ controller: "profiles", action: "show" });
  });

  it("emits routes_to intents with camelized controller names", () => {
    const content = ["Rails.application.routes.draw do", "  namespace :admin do", "    resources :reports, only: [:index]", "  end", "end"].join("\n");
    const result = new RoutesScanner().scan([{ relPath: "config/routes.rb", content }]);
    expect(result.intents[0]).toMatchObject({
      relationship: "routes_to",
      toType: "controller",
      toName: "Admin::ReportsController",
    });
  });
});
