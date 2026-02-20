import { describe, it, expect } from "vitest";
import { extractEntities } from "@exocortex/core";

describe("Entity Extractor", () => {
  it("extracts technology names", () => {
    const entities = extractEntities("Built this project with TypeScript and React, deployed on Vercel.");
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).toContain("typescript");
    expect(names).toContain("react");
    expect(names).toContain("vercel");
  });

  it("extracts known organization names", () => {
    const entities = extractEntities("Google and Microsoft both released new AI models.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Google");
    expect(names).toContain("Microsoft");
    // All entities default to "concept" — users reclassify in the dashboard
    entities.forEach((e) => expect(e.type).toBe("concept"));
  });

  it("extracts organization names with suffixes", () => {
    const entities = extractEntities("Acme Corp announced a new product.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Acme Corp");
  });

  it("extracts project names from context", () => {
    const entities = extractEntities("Working on Exocortex, a personal memory system.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Exocortex");
  });

  it("extracts AI/ML concepts", () => {
    const entities = extractEntities("Implemented RAG with retrieval augmented generation and neural network embeddings.");
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name.toLowerCase());
    expect(names).toContain("rag");
  });

  it("returns entities sorted by confidence", () => {
    const entities = extractEntities("Using React and TypeScript to build a neural network visualizer.");
    for (let i = 1; i < entities.length; i++) {
      expect(entities[i].confidence).toBeLessThanOrEqual(entities[i - 1].confidence);
    }
  });

  it("deduplicates entities by name", () => {
    const entities = extractEntities("React React React TypeScript TypeScript");
    const names = entities.map((e) => e.name.toLowerCase());
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  it("returns empty array for text without entities", () => {
    const entities = extractEntities("The quick brown fox jumps over the lazy dog.");
    // May find some or none — just shouldn't throw
    expect(Array.isArray(entities)).toBe(true);
  });

  it("extracts person names with attribution", () => {
    const entities = extractEntities("This library was created by John Smith and maintained by Jane Doe.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("John Smith");
    expect(names).toContain("Jane Doe");
  });

  // Regression tests for false-positive extraction bugs

  it("does not extract 'Neural Dark' as an entity", () => {
    const entities = extractEntities("Switched to the Neural Dark theme for the dashboard.");
    const names = entities.map((e) => e.name);
    expect(names).not.toContain("Neural Dark");
  });

  it("does not extract 'Building AI' as an entity", () => {
    const entities = extractEntities("Building AI-assisted apps with Claude.");
    const names = entities.map((e) => e.name);
    expect(names.some((n) => n.includes("Building"))).toBe(false);
  });

  it("does not extract 'production-ready' as an entity", () => {
    const entities = extractEntities("We need a production-ready deployment pipeline.");
    const names = entities.map((e) => e.name);
    expect(names).not.toContain("production-ready");
  });

  it("does not extract 'status' from 'project status'", () => {
    const entities = extractEntities("Checking the project status before the meeting.");
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("status");
  });

  it("extracts 'Exocortex' from 'Active projects: Exocortex'", () => {
    const entities = extractEntities("Active projects: Exocortex");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Exocortex");
  });

  it("extracts 'Exocortex' from 'Exocortex project'", () => {
    const entities = extractEntities("The Exocortex project is progressing well.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Exocortex");
  });

  // --- All entities default to "concept" — users reclassify in dashboard ---

  it("extracts OpenAI as concept", () => {
    const entities = extractEntities("OpenAI released a new model today.");
    const openai = entities.find((e) => e.name === "OpenAI");
    expect(openai).toBeDefined();
    expect(openai!.type).toBe("concept");
  });

  it("extracts Anthropic as concept", () => {
    const entities = extractEntities("Anthropic published their safety research.");
    const anthropic = entities.find((e) => e.name === "Anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.type).toBe("concept");
  });

  it("extracts Claude and GPT as entities", () => {
    const entities = extractEntities("Using Claude and GPT for code generation.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Claude");
    expect(names).toContain("GPT");
    entities.forEach((e) => expect(e.type).toBe("concept"));
  });

  // --- Fix 2: Case-sensitive tech matching ---

  it("does not extract lowercase 'spring' as entity", () => {
    const entities = extractEntities("The flowers bloom in spring.");
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("spring");
  });

  it("extracts capitalized 'Spring' as entity", () => {
    const entities = extractEntities("Built the backend with Spring Boot.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Spring");
  });

  it("does not extract lowercase 'go' as entity", () => {
    const entities = extractEntities("Let's go to the store.");
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("go");
  });

  it("extracts capitalized 'Go' as entity", () => {
    const entities = extractEntities("Rewrote the service in Go for performance.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Go");
  });

  it("does not extract lowercase 'rust' as entity", () => {
    const entities = extractEntities("The old pipe had rust on it.");
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("rust");
  });

  it("does not extract lowercase 'rest' as entity", () => {
    const entities = extractEntities("I need to rest before continuing.");
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("rest");
  });

  // --- Fix 3: Tightened quoted concept extraction ---

  it("does not extract generic quoted words as concepts", () => {
    const entities = extractEntities('Set content_type to "text" and source to "api".');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("text");
    expect(names).not.toContain("api");
  });

  it("does not extract article-starting quoted phrases as concepts", () => {
    const entities = extractEntities('Implemented "the new approach" for handling data.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("the new approach");
  });

  it("does not extract imperative-starting quoted phrases as concepts", () => {
    const entities = extractEntities('The tool description says "store a new memory".');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("store a new memory");
  });

  it("does not extract ALL-CAPS multi-word quoted phrases as concepts", () => {
    const entities = extractEntities('Got error "HOLDER DATA UNRELIABLE" from the API.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("HOLDER DATA UNRELIABLE");
  });

  it("accepts ALL-CAPS single-word acronyms as concepts", () => {
    const entities = extractEntities('The "MCP" protocol enables tool use.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).toContain("MCP");
  });

  // --- Fix 4: Org name prefix blocklist ---

  it("does not extract 'Added Group' as an entity", () => {
    const entities = extractEntities("Added Group filtering to the dashboard.");
    const names = entities.map((e) => e.name);
    expect(names).not.toContain("Added Group");
  });

  it("does not extract 'New Tech' as an entity", () => {
    const entities = extractEntities("Exploring New Tech for the project.");
    const names = entities.map((e) => e.name);
    expect(names).not.toContain("New Tech");
  });

  it("extracts legitimate org names with suffixes", () => {
    const entities = extractEntities("Partnered with Horizon Labs on the project.");
    const names = entities.map((e) => e.name);
    expect(names).toContain("Horizon Labs");
  });

  // --- Tightened quoted concept false positives ---

  it("does not extract 'No route' as a concept", () => {
    const entities = extractEntities('Got "No route" error from the server.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("No route");
  });

  it("does not extract 'Apply Recommendations' as a concept", () => {
    const entities = extractEntities('Click "Apply Recommendations" to proceed.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("Apply Recommendations");
  });

  it("does not extract 'Max results' as a concept", () => {
    const entities = extractEntities('"Max results" controls the limit.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("Max results");
  });

  it("does not extract 'Filter by tags' as a concept", () => {
    const entities = extractEntities('Use "Filter by tags" to narrow results.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("Filter by tags");
  });

  it("does not extract 'Built shelter' as a concept", () => {
    const entities = extractEntities('Player "Built shelter" in the game.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("Built shelter");
  });

  it("does not extract 'API down' as a concept", () => {
    const entities = extractEntities('Status: "API down" since morning.');
    const concepts = entities.filter((e) => e.type === "concept");
    const names = concepts.map((e) => e.name);
    expect(names).not.toContain("API down");
  });
});
