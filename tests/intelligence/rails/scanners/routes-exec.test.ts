import { EventEmitter } from "node:events";
import { jest } from "@jest/globals";

jest.unstable_mockModule("node:child_process", () => ({ spawn: jest.fn() }));

const { spawn } = await import("node:child_process");
const { RoutesScanner } = await import("../../../../src/intelligence/rails/scanners/routes-scanner.js");

const mockSpawn = spawn as jest.Mock;

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

afterEach(() => {
  mockSpawn.mockReset();
});

const SAMPLE_ROUTES_OUTPUT = [
  "                    Prefix Verb   URI Pattern                                                                              Controller#Action",
  "                      root GET    /                                                                                        pages#home",
  "                 dashboard GET    /dashboard(.:format)                                                                     dashboard#show",
  "                    users GET    /users(.:format)                                                                          users#index",
  "                             POST   /users(.:format)                                                                          users#create",
  "                 new_user GET    /users/new(.:format)                                                                      users#new",
  "                edit_user GET    /users/:id/edit(.:format)                                                                 users#edit",
  "                     user GET    /users/:id(.:format)                                                                      users#show",
  "                             PATCH  /users/:id(.:format)                                                                      users#update",
  "                             DELETE /users/:id(.:format)                                                                      users#destroy",
  "               api_reports GET    /api/reports(.:format)                                                                    api/reports#index",
  "        api_report_archive POST   /api/reports/:id/archive(.:format)                                                        api/reports#archive",
  "",
  "Routes for mounted engine: MyEngine",
  "   ...",
].join("\n");

describe("RoutesScanner.exec", () => {
  it("parses bin/rails routes output into entities and intents", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const scanner = new RoutesScanner();
    const promise = scanner.exec("/fake/root");

    proc.stdout.emit("data", Buffer.from(SAMPLE_ROUTES_OUTPUT));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(11);

    // Check a standard resource route
    const usersIndex = result!.entities.find((e) => e.id === "route:GET /users");
    expect(usersIndex).toMatchObject({
      verb: "GET",
      path: "/users",
      controller: "users",
      action: "index",
      routeName: "users",
    });

    // Check a namespaced route
    const apiReports = result!.entities.find((e) => e.id === "route:GET /api/reports");
    expect(apiReports).toMatchObject({
      verb: "GET",
      path: "/api/reports",
      controller: "api/reports",
      action: "index",
    });

    // Check root route
    const root = result!.entities.find((e) => e.id === "route:GET /");
    expect(root).toMatchObject({
      verb: "GET",
      path: "/",
      controller: "pages",
      action: "home",
    });

    // Check intents are generated
    expect(result!.intents.length).toBe(11);
    expect(result!.intents[0]).toMatchObject({
      relationship: "routes_to",
      toType: "controller",
      toName: "PagesController",
    });
  });

  it("returns null when no data lines exist", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const scanner = new RoutesScanner();
    const promise = scanner.exec("/fake/root");

    proc.stdout.emit("data", Buffer.from("                    Prefix Verb   URI Pattern                                                                              Controller#Action\n"));
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("returns null when the command fails", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const scanner = new RoutesScanner();
    const promise = scanner.exec("/fake/root");

    proc.stdout.emit("data", Buffer.from(""));
    proc.stderr.emit("data", Buffer.from("could not find bin/rails"));
    proc.emit("close", 1);

    const result = await promise;
    expect(result).toBeNull();
  });

  it("handles routes without a prefix name", async () => {
    const proc = fakeProc();
    mockSpawn.mockReturnValue(proc);

    const scanner = new RoutesScanner();
    const promise = scanner.exec("/fake/root");

    proc.stdout.emit(
      "data",
      Buffer.from(
        [
          "                    Prefix Verb   URI Pattern                                                                              Controller#Action",
          "                             POST   /webhooks/stripe(.:format)                                                               webhooks#create",
          "                    health GET    /health(.:format)                                                                          health#show",
        ].join("\n"),
      ),
    );
    proc.stderr.emit("data", Buffer.from(""));
    proc.emit("close", 0);

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.entities).toHaveLength(2);

    const stripe = result!.entities.find((e) => e.path === "/webhooks/stripe");
    expect(stripe).toMatchObject({ verb: "POST", controller: "webhooks", action: "create" });
    expect(stripe!.routeName).toBeUndefined();
  });
});
