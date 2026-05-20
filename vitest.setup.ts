import "@testing-library/jest-dom/vitest";
import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Test-only env vars so lib/env.ts loads without crashing.
process.env.NEXT_PUBLIC_APP_URL          = "http://localhost:3000";
process.env.NEXT_PUBLIC_SUPABASE_URL     = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY    = "test-service-role-key";
process.env.AWS_REGION                   = "eu-west-1";
process.env.AWS_S3_BUCKET                = "test-bucket";
process.env.AWS_ACCESS_KEY_ID            = "test-key";
process.env.AWS_SECRET_ACCESS_KEY        = "test-secret";
process.env.OPENAI_API_KEY               = "test-openai-key";
process.env.AI_MODEL                     = "gpt-4.1-mini";
process.env.API_INTERNAL_KEY             = "test-internal-key";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
