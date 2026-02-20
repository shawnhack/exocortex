export type EntityType =
  | "person"
  | "project"
  | "technology"
  | "organization"
  | "concept";

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  metadata: Record<string, unknown>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateEntityInput {
  name: string;
  type?: EntityType;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface EntityRelationship {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship: string;
  confidence: number;
  memory_id: string | null;
  context: string | null;
  created_at: string;
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  relationship: string;
  confidence: number;
  context?: string;
}
