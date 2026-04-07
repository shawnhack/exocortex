import { describe, it, expect } from "vitest";
import { validateContent, redactSensitiveData } from "./action-validator.js";

describe("validateContent", () => {
  it("passes normal content", () => {
    const result = validateContent("Normal text about coding patterns.");
    expect(result.safe).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("detects API keys", () => {
    const result = validateContent("key: sk-ant-api03-abc123def456ghijklmnopqrstuvwxyz");
    expect(result.safe).toBe(false);
    expect(result.warnings.some(w => w.type === "api_key")).toBe(true);
  });

  it("detects connection strings", () => {
    const result = validateContent("postgresql://admin:secret@prod.db.example.com:5432/mydb");
    expect(result.safe).toBe(false);
    expect(result.warnings.some(w => w.type === "connection_string")).toBe(true);
  });

  it("ignores template connection strings", () => {
    const result = validateContent("postgresql://user:password@localhost/dbname");
    expect(result.safe).toBe(true);
  });

  it("detects private keys", () => {
    const result = validateContent("-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    expect(result.safe).toBe(false);
  });
});

describe("redactSensitiveData", () => {
  it("redacts API keys", () => {
    const result = redactSensitiveData("key: sk-ant-api03-abc123def456ghijklmnopqrstuvwxyz");
    expect(result).toContain("[REDACTED:api_key]");
    expect(result).not.toContain("sk-ant-api03");
  });

  it("leaves safe content unchanged", () => {
    const input = "This is normal text.";
    expect(redactSensitiveData(input)).toBe(input);
  });
});
