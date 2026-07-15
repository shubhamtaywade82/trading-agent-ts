// Under Jest's real ESM mode (--experimental-vm-modules), `describe`/`it`/
// `expect` are globals, but `jest` specifically isn't reliably injected into
// every test module's scope — restore it explicitly so jest.fn()/spyOn()/
// mock() keep working without touching every test file.
import { jest } from "@jest/globals";
globalThis.jest = jest;
