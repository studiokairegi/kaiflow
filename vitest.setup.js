import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount rendered components between tests (Testing Library does not do this automatically under Vitest).
afterEach(() => cleanup());
