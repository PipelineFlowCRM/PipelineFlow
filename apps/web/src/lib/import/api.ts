// Typed client for /api/import/*. Mirrors the route layer's response
// shapes so the wizard never touches the raw fetch wrapper directly —
// keeps a single place to bump shapes when the schema evolves.
import { api } from '@/lib/api';

export type EntityType = 'company' | 'contact' | 'deal' | 'note';

export interface DetectedPreset {
  key: string;
  sourceLabel: string;
  entityType: EntityType;
  score: number;
  externalSource: string;
}

export interface UploadResponse {
  jobId: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  detectedPreset: DetectedPreset | null;
  suggestedMapping: Record<string, string | null>;
  canonicalFields: string[];
}

export interface ValidationError {
  row: number;
  column: string | null;
  value: string | null;
  reason: string;
}

export interface RunSummary {
  totalRows: number;
  willCreate: number;
  willUpdate: number;
  willError: number;
  stubCompaniesCreated: number;
  stubContactsCreated: number;
  unmappedStages: string[];
  distinctStages: string[];
  // Source-stage → existing PipelineStage.id pairs that the server
  // resolved automatically by exact name match. The wizard merges
  // these into its sub-step state on each dry-run so the user only has
  // to manually pick stages that genuinely don't exist in PF yet.
  autoMappedStages: Record<string, number>;
}

export interface RunResponse {
  summary: RunSummary;
  errors: ValidationError[];
  createdIds?: number[];
  updatedIds?: number[];
}

export interface ImportJobDto {
  id: string;
  entityType: EntityType;
  filename: string;
  status: 'pending' | 'validating' | 'validated' | 'committing' | 'completed' | 'failed';
  presetUsed: string | null;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  errorRows: number;
  stubCompaniesCreated: number;
  stubContactsCreated: number;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export const importApi = {
  upload: async (file: File, entityType: EntityType): Promise<UploadResponse> => {
    const fd = new FormData();
    fd.append('entityType', entityType);
    fd.append('file', file);
    const res = await fetch(`/api/import/upload`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const data = JSON.parse(text);
        if (data?.error) msg = data.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return (await res.json()) as UploadResponse;
  },

  dryRun: (
    jobId: string,
    body: {
      entityType: EntityType;
      mapping: Record<string, string | null>;
      stageMapping?: Record<string, number>;
      externalSource?: string;
    },
  ) => api.post<RunResponse>(`/import/${jobId}/dry-run`, body),

  commit: (
    jobId: string,
    body: {
      entityType: EntityType;
      mapping: Record<string, string | null>;
      stageMapping?: Record<string, number>;
      externalSource?: string;
    },
  ) => api.post<RunResponse>(`/import/${jobId}/commit`, body),

  listJobs: (cursor?: string) =>
    api.get<{ jobs: ImportJobDto[]; nextCursor: string | null }>(
      `/import/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  // Loads a job for the resume wizard. `resume` is null if the source
  // CSV is gone (lifecycle-expired or never landed) — the UI then only
  // offers Delete. `sourceUnavailable` is set when the server confirms
  // a NoSuchKey rather than a transient AWS hiccup; transient failures
  // bubble up as 503 from this call and surface as `query.isError`.
  getJob: (jobId: string) =>
    api.get<{ job: ImportJobDto; resume: ResumePayload | null; sourceUnavailable?: boolean }>(
      `/import/jobs/${jobId}`,
    ),

  deleteJob: (jobId: string) => api.delete<{ ok: true }>(`/import/jobs/${jobId}`),

  errorsCsvUrl: (jobId: string) => `/api/import/jobs/${jobId}/errors.csv`,
};

export interface ResumePayload {
  headers: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
  detectedPreset: {
    preset: { key: string; sourceLabel: string; entityType: EntityType; externalSource: string };
    score: number;
    matchedHeaders: string[];
  } | null;
  canonicalFields: string[];
  mapping: Record<string, string | null>;
  stageMapping: Record<string, number>;
  // The most recent dry-run / commit result persisted on the job row.
  // Lets the wizard rehydrate Step 3 with the previous summary +
  // errors instead of forcing the user to re-run the dry-run.
  priorRun: { summary: RunSummary; errors: ValidationError[] } | null;
}
