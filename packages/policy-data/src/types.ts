export type TrainingDefault = "no" | "yes" | "opt-out-required" | "unclear";

/**
 * What a provider does with API traffic, as published on its official pages. Policies differ
 * per model (e.g. Anthropic "Covered Models" require 30-day retention), so entries can target
 * a subset of a provider's models. Every entry records when it was last checked.
 */
export interface DataPolicy {
  id: string;
  /** pi-ai provider id this entry applies to, e.g. "anthropic". */
  provider: string;
  /** Regex (source string) over model ids. Omitted = every model of the provider. More specific entries win. */
  modelPattern?: string;
  label: string;
  trainsOnApiData: TrainingDefault;
  /** Default retention of inputs/outputs, in days. null = not stated / depends on configuration. */
  retentionDays: number | null;
  retentionSummary: string;
  flaggedContent: string;
  humanReview: string;
  zeroDataRetention: { available: boolean; selfServe: boolean; summary: string };
  residency: string;
  /** Warnings Airlock should show before sending to this provider/model. */
  warnings: string[];
  sources: string[];
  /** ISO date (YYYY-MM-DD) the sources were last read. */
  verifiedOn: string;
}
