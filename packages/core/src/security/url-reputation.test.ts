import { describe, it, expect } from "vitest";
import { checkUrl, filterUrls } from "./url-reputation.js";

describe("checkUrl", () => {
  it("allows legitimate URLs", () => {
    expect(checkUrl("https://github.com/user/repo").allowed).toBe(true);
    expect(checkUrl("https://www.anthropic.com").allowed).toBe(true);
    expect(checkUrl("https://google.com/search").allowed).toBe(true);
  });

  it("blocks non-HTTP protocols", () => {
    expect(checkUrl("javascript:alert(1)").allowed).toBe(false);
    expect(checkUrl("file:///etc/passwd").allowed).toBe(false);
    expect(checkUrl("data:text/html,<h1>test</h1>").allowed).toBe(false);
  });

  it("blocks localhost and internal IPs (SSRF)", () => {
    expect(checkUrl("http://localhost/admin").allowed).toBe(false);
    expect(checkUrl("http://127.0.0.1/api").allowed).toBe(false);
    expect(checkUrl("http://192.168.1.1/admin").allowed).toBe(false);
    expect(checkUrl("http://10.0.0.1/internal").allowed).toBe(false);
  });

  it("blocks IP-as-domain", () => {
    expect(checkUrl("http://1.2.3.4/phishing").allowed).toBe(false);
  });

  it("blocks typosquats", () => {
    expect(checkUrl("https://githuh.com/phish").allowed).toBe(false);
    expect(checkUrl("https://g0ogle.com").allowed).toBe(false);
  });

  it("flags suspicious TLDs but allows them", () => {
    const result = checkUrl("https://example.tk/free");
    expect(result.allowed).toBe(true);
    expect(result.riskLevel).toBe("suspicious");
  });

  it("correctly handles RFC 1918 172.x range", () => {
    expect(checkUrl("http://172.16.0.1/internal").allowed).toBe(false);
    expect(checkUrl("http://172.31.255.1/internal").allowed).toBe(false);
    // 172.15.x and 172.32.x are public IPs
    expect(checkUrl("http://172.15.0.1/public").allowed).toBe(false); // blocked as IP-as-domain
  });
});

describe("filterUrls", () => {
  it("separates allowed from blocked", () => {
    const result = filterUrls([
      "https://github.com/repo",
      "javascript:alert(1)",
      "https://example.com/page",
    ]);
    expect(result.allowed).toHaveLength(2);
    expect(result.blocked).toHaveLength(1);
  });
});
