# Mastra 1.x Workflow Suspension and Human-in-the-Loop State Resumption

**Scope:** Resolves Wayfinder Ticket [#41](https://github.com/Rayesh-company/fast-book-learning/issues/41) (Part of Map [#39](https://github.com/Rayesh-company/fast-book-learning/issues/39)).  
**Primary Sources:** Official Mastra 1.x documentation (`https://mastra.ai/docs/workflows/suspend-and-resume`, `snapshots`, `control-flow`, `human-in-the-loop`, and API references), `@mastra/core@^1.74.0`, `@mastra/libsql@^1.25.0`.

---

## 1. Executive Summary

Wayfinder Ticket #41 investigates how Mastra 1.x orchestrates long-running, multi-step workflows that require client-driven suspension and resumption across study phases in **`حالت یادگیری` (Learning Mode)**:
1. **Phase 1: آماده‌سازی (Priming)** — ~4 min off-device drawing on paper → suspends waiting for photo + voice explanation.
2. **Phase 2: خواندن (Reading)** — ~10 min active reading in PDF.js → suspends waiting for "پایان خواندن" signal.
3. **Phase 3: توضیح آزاد فاینمن (Feynman Dump)** — ~6 min blank-page recall → suspends for photo/audio capture, runs 5-stage grading pipeline, returns verified feedback.
4. **Phase 4: آزمون بازیابی (Quiz)** — ~5 min spaced retrieval → generates 5 questions, suspends per item or batch for learner text/voice answers.
5. **Phase 5: جمع‌بندی نشست (Session Close)** — ~2 min summary → commits mastery deltas, computes SM-2 intervals, outputs next session plan.

### Key Findings
1. **Native Step-Level Suspension (`suspend()` / `resumeData`)**: In Mastra 1.x, steps declare both `suspendSchema` (payload sent to the client when pausing) and `resumeSchema` (payload required from the client to resume). When `await suspend(data)` is called inside a step's `execute` block, execution halts immediately and the workflow status transitions to `'suspended'`.
2. **Durable Snapshot Persistence via LibSQL**: Every suspension automatically serializes the complete workflow execution state (step graph, variable context, step outputs, and payload) to storage (`LibSQLStore` configured in `agent/src/mastra/index.ts`). Suspended workflows safely survive process restarts, deployments, and multi-hour client delays.
3. **SSE Streaming & Clean Stream Cut (`closeOnSuspend: true`)**: When invoking `run.stream()`, Mastra emits lifecycle events (`step_start`, `step_progress`, `step_suspended`) over Server-Sent Events. Setting `closeOnSuspend: true` ensures the SSE stream cleanly terminates upon reaching a suspension point, allowing the client to transition UI state without hanging connections.
4. **Resumption Protocol via HTTP/REST**: A client resumes the workflow by calling Mastra's runtime API (`POST /api/workflows/:workflowId/resume` or programmatically via `run.resume({ step, resumeData })`), providing the `runId`, target `stepId`, and validated `resumeData`. This starts a new execution stream for the subsequent step.

---

## 2. Mastra 1.x Suspend and Resume API Mechanics

### 2.1 Step Definition with Typed Suspension (`createStep`)

Mastra 1.x introduces explicit Zod schema contracts for suspension and resumption:

```typescript
import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

export const primingStep = createStep({
  id: 'priming-step',
  inputSchema: z.object({
    sessionId: z.string(),
    bookId: z.string(),
    sectionId: z.string(),
    seedConcepts: z.array(z.string()),
  }),
  outputSchema: z.object({
    transcript: z.string(),
    photoPath: z.string().nullable(),
    extractedClaims: z.array(z.any()),
  }),
  suspendSchema: z.object({
    promptFa: z.string(),
    seedConcepts: z.array(z.string()),
    worksheetTemplate: z.string(),
  }),
  resumeSchema: z.object({
    photoPath: z.string().nullable(),
    transcript: z.string(),
    durationSeconds: z.number(),
  }),
  execute: async ({ inputData, resumeData, suspend, context }) => {
    // If resumeData is not provided, this is the first entry: prepare prompt and suspend
    if (!resumeData) {
      return await suspend({
        promptFa: 'کدام مفاهیم را به هم وصل کردی و چرا؟ روی کاغذ ترسیم کنید و توضیح صوتی ضبط نمایید.',
        seedConcepts: inputData.seedConcepts,
        worksheetTemplate: 'predicted_model',
      });
    }

    // Workflow has resumed with learner submission:
    const { photoPath, transcript } = resumeData;
    
    // Process prediction claims (Stage 1-2 only, no verification yet)
    return {
      transcript,
      photoPath,
      extractedClaims: [], // claims extracted from transcript
    };
  },
});
```

### 2.2 Workflow Construction (`createWorkflow`)

Steps are chained sequentially using `.then()`:

```typescript
import { createWorkflow } from '@mastra/core/workflows';

export const studySessionWorkflow = createWorkflow({
  id: 'study-session-workflow',
  inputSchema: SessionInputSchema,
  outputSchema: SessionOutputSchema,
})
  .then(primingStep)
  .then(readingStep)
  .then(feynmanStep)
  .then(quizStep)
  .then(closeSessionStep);
```

---

## 3. Storage Persistence & Process Resilience (LibSQL)

### 3.1 Snapshot Topology
When Mastra is initialized with `LibSQLStore` (as in `agent/src/mastra/index.ts` pointing to `file:./data/mastra.sqlite`):
- `mastra_workflow_runs`: Stores `runId`, `workflowId`, `status` (`'pending' | 'running' | 'suspended' | 'completed' | 'failed'`), `createdAt`, `updatedAt`.
- `mastra_workflow_snapshot`: Stores step execution outputs, active execution paths, and serialized variable context keyed by `runId`.

### 3.2 State Recovery Pattern
When a client resumes a session (possibly hours later or after a server restart):

```typescript
import { createWorkflowStateReader } from '@mastra/core/workflows';

const workflow = mastra.getWorkflow('studySessionWorkflow');
const state = await workflow.getWorkflowRunById(runId);

if (state?.status === 'suspended') {
  const reader = createWorkflowStateReader(state);
  const suspendedStep = reader.getSuspendedStep();
  
  // Re-instantiate the run from stored snapshot
  const run = await workflow.createRun({ runId: state.runId });

  // Resume with verified client submission
  await run.resume({
    step: suspendedStep.path,
    resumeData: clientPayload,
  });
}
```

---

## 4. SSE Wire Protocol & Gateway Proxying

### 4.1 Server-Sent Events Lifecycle
When streaming workflow progress with `run.stream()`:
- `step_start`: Emitted when entering a step.
- `step_progress`: Intermediate progress tokens or LLM chunks.
- `step_suspended`: Emitted when `suspend()` is invoked, containing the `suspendSchema` payload.
- `stream_close`: Automatically closed because `closeOnSuspend: true` is enabled.

### 4.2 HTTP Wire Endpoints in Mastra Server
Mastra exposes REST endpoints out of the box when running `mastra dev` on port `4111`:
1. `POST /api/workflows/:workflowId/start`  
   Body: `{ inputData: { sessionId, bookId, sectionId, ... } }`  
   Returns: `{ runId: "run_abc123", status: "running" }`
2. `GET /api/workflows/:workflowId/stream?runId=run_abc123`  
   Opens SSE stream receiving step events.
3. `POST /api/workflows/:workflowId/resume`  
   Body: `{ runId: "run_abc123", step: "priming-step", resumeData: { ... } }`  
   Resumes execution and allows opening a new SSE stream.

---

## 5. Architectural Recommendation for `chat-with-books`

For **`حالت یادگیری`**, the session coordination should follow this pattern:

```
[ Client Browser (ui/learning.html) ]
             |
             | 1. HTTP POST /api/learning/session/start
             v
[ Python Gateway (server.py) ]
             |
             | 2. Proxy to Mastra (:4111)
             v
[ Mastra Workflow: studySessionWorkflow ]
      - Runs Step 1: Priming
      - Calls suspend({ promptFa, seedConcepts })
      - Closes SSE stream with status='suspended'
             |
[ Client Learner works off-device (4 min) ]
             |
             | 3. Uploads audio & photo -> POST /api/learning/session/resume
             v
[ Python Gateway (server.py) ]
      - Transcribes audio via AvalAI ASR
      - Calls Mastra POST /api/workflows/studySessionWorkflow/resume
             v
[ Mastra Workflow Resumes ]
      - Extracts claims from transcript
      - Proceeds to Step 2: Reading (suspends until 'done reading')
      - ... and repeats through Feynman, Quiz, and Close.
```

### Key Decisions Resolved for Downstream Tickets:
- **For #45 (SSE Wire Protocol)**: The gateway will expose `/api/learning/session/start`, `/stream`, and `/resume`, translating Mastra's internal step lifecycle into the domain events `phase_changed`, `claim_extracted`, `verdict_ready`.
- **For #42 (Grounded Grading)**: Grounded grading executes synchronously during Phase 3 before yielding feedback, avoiding nested suspension complexity.
- **For #44 (Quiz Generator)**: Quiz items can be served either item-by-item (micro-suspension) or as a 5-item batch with single submission, as specced in the Week-5 Gate.

---

## 6. Primary Reference Links
- Mastra Workflow Suspend & Resume: `https://mastra.ai/docs/workflows/suspend-and-resume.md`
- Mastra Snapshots & Persistence: `https://mastra.ai/docs/workflows/snapshots.md`
- Mastra Human-in-the-Loop Guide: `https://mastra.ai/docs/workflows/human-in-the-loop.md`
- Mastra Workflow State Reader: `https://mastra.ai/reference/workflows/workflow-state-reader.md`
