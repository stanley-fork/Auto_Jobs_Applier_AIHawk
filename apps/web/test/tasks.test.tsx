// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { TASK_LIST_LIMIT } from "@invisible-dots/shared/browser";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { TaskDrawer } from "../src/components/tasks/task-drawer";
import { TasksView } from "../src/components/tasks/TasksView";
import { Toaster } from "../src/components/ui/sonner";
import { stubMatchMedia } from "./support/browser";
import { approvalRecord, dotRecord, FakeControlPlane, taskRecord } from "./support/control-plane";

const router = { push: vi.fn(), replace: vi.fn() };
let segment: string | null = null;
vi.mock("next/navigation", () => ({
  usePathname: () => "/dots/d1/tasks",
  useRouter: () => router,
  useSelectedLayoutSegment: () => segment,
}));

let plane: FakeControlPlane;

beforeEach(() => {
  segment = null;
  router.push.mockClear();
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const requested = (pattern: RegExp) => plane.requests.filter((r) => pattern.test(r));

/** The Tasks page as the Dot's layout puts it: inside the Dot's shell, with the drawer's page as its child. */
async function renderTasks(drawerOf: string | null = null) {
  segment = drawerOf;
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <TasksView>{drawerOf ? <TaskDrawer taskId={drawerOf} /> : null}</TasksView>
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
      <Toaster />
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, hidden: true });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

function runningTask(id: string, change: Partial<ReturnType<typeof taskRecord>> = {}) {
  return taskRecord(id, { status: "RUNNING", started_at: minutesAgo(3), spent_usd: 0.12, description: `Running ${id}`, ...change });
}

describe("the Tasks page", () => {
  it("invites the first task when there are none, and does not read the event log for nothing", async () => {
    await renderTasks();
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
    expect(plane.eventQueries).toEqual([]);
  });

  it("says so when the tasks cannot be loaded", async () => {
    plane.tasks = [];
    const real = plane.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/tasks") && (init?.method ?? "GET") === "GET" ? Response.json({ error: "down", message: "the control plane said no" }, { status: 500 }) : real(input, init),
      ),
    );
    await renderTasks();
    expect((await screen.findByText("Could not load the tasks")).closest("[role=alert]")?.textContent).toContain("the control plane said no");
  });

  it("puts each task in its section: running, scheduled, queued in dispatch order, and finished", async () => {
    plane.tasks = [
      runningTask("r1"),
      taskRecord("q-low", { description: "Queued low", priority: -10, created_at: minutesAgo(50) }),
      taskRecord("q-urgent", { description: "Queued urgent", priority: 100, created_at: minutesAgo(10) }),
      taskRecord("q-normal", { description: "Queued normal", created_at: minutesAgo(30) }),
      taskRecord("s1", { description: "Scheduled later", scheduled_at: minutesAhead(185) }),
      taskRecord("h1", { description: "Finished well", status: "COMPLETED", finished_at: minutesAgo(5), started_at: minutesAgo(9), summary: "All done", spent_usd: 0.4 }),
    ];
    await renderTasks();
    const running = await screen.findByRole("region", { name: /^Running/ });
    expect(within(running).getByRole("article", { name: "Running r1" })).toBeTruthy();

    const queue = screen.getByRole("region", { name: /^Queue/ });
    const queued = within(queue).getAllByRole("article");
    expect(queued.map((q) => q.getAttribute("aria-label"))).toEqual(["Queued urgent", "Queued normal", "Queued low"]);
    expect(within(queued[0]!).getByText("Next")).toBeTruthy();
    expect(within(queued[1]!).getByText("#2")).toBeTruthy();
    expect(within(queued[0]!).getByText("Urgent")).toBeTruthy();
    expect(within(queued[2]!).getByText("Low")).toBeTruthy();

    const scheduled = screen.getByRole("region", { name: /^Scheduled/ });
    expect(within(scheduled).getByText(/Starts/).textContent).toContain("in 3h");

    const history = screen.getByRole("region", { name: /^History/ });
    const row = within(history).getByRole("row", { name: /Finished well/ });
    expect(within(row).getByText("Completed")).toBeTruthy();
    expect(within(row).getByText("$0.40")).toBeTruthy();
    expect(within(row).getByText("All done")).toBeTruthy();
    expect(within(row).getByText("4m 0s")).toBeTruthy();
  });

  it("lists the newest page, and reads the older ones when asked, joining them to what is shown", async () => {
    // The tasks of the Queue region's ordered list, read from the DOM: a role query over two hundred cards costs a
    // few hundred milliseconds in jsdom, and waitFor repeats it every 50, which alone used up the test's time. The
    // region is found again at each call (by its heading, a text query), since it is drawn anew when the list grows.
    const queueItems = () => screen.getByText("Queue", { selector: "h2" }).closest("section")!.querySelectorAll(":scope ol > li");
    // 205 queued tasks, one created a minute after the other: the newest 200 are the first page, five are past it.
    const base = Date.now() - 3_600_000;
    plane.tasks = Array.from({ length: TASK_LIST_LIMIT + 5 }, (_, i) => taskRecord(`q${String(i).padStart(3, "0")}`, { created_at: new Date(base + i * 1000).toISOString() }));
    await renderTasks();
    // Found by its words, then checked to be a status: a page-wide role query is what costs the time here.
    const notice = (await screen.findByText(new RegExp(`The newest ${TASK_LIST_LIMIT} tasks are listed`))).closest<HTMLElement>("[role=status]")!;
    expect(notice).not.toBeNull();
    expect(queueItems()).toHaveLength(TASK_LIST_LIMIT);
    expect(screen.queryByText("task q000")).toBeNull();
    const pagedQueries = () => plane.taskQueries.filter((query) => query.before !== null);
    expect(pagedQueries()).toEqual([]);

    await userEvent.click(within(notice).getByRole("button", { name: "Show older tasks" }));
    await waitFor(() => expect(queueItems()).toHaveLength(TASK_LIST_LIMIT + 5));
    expect(screen.getByText("task q000")).toBeTruthy();
    // The page went on after the last task of the newest one, and the list ended there: nothing more to ask for.
    expect(pagedQueries()).toEqual([{ limit: null, before: "q005" }]);
    expect(screen.queryByRole("button", { name: "Show older tasks" })).toBeNull();

    // A task that arrives is read with the newest page again, and the older ones stay.
    plane.tasks.push(taskRecord("q999", { created_at: new Date().toISOString() }));
    act(() => plane.push("d1", "task.created", { task_id: "q999" }));
    // Waited for by the list's length, as above: a page-wide text query over two hundred cards, repeated every 50 ms,
    // used up waitFor's second on a loaded machine before the refresh (300 ms after the event) had drawn the list.
    await waitFor(() => expect(queueItems()).toHaveLength(TASK_LIST_LIMIT + 6));
    expect(screen.getByText("task q999")).toBeTruthy();
    expect(screen.getByText("task q000")).toBeTruthy();
  });

  it("does not offer older tasks to a Dot whose tasks fit a page", async () => {
    plane.tasks = Array.from({ length: TASK_LIST_LIMIT - 1 }, (_, i) => taskRecord(`f${i}`));
    await renderTasks();
    await screen.findByRole("region", { name: /^Queue/ });
    expect(screen.queryByRole("button", { name: "Show older tasks" })).toBeNull();
    expect(screen.queryByText(/tasks are listed/)).toBeNull();
  });

  it("links every task to its own address", async () => {
    plane.tasks = [runningTask("r1"), taskRecord("q1"), taskRecord("h1", { status: "FAILED", finished_at: minutesAgo(1), error: "boom" })];
    await renderTasks();
    for (const description of ["Running r1", "task q1", "task h1"]) {
      const id = description.split(" ")[1];
      expect(screen.getByRole("link", { name: description }).getAttribute("href")).toBe(`/dots/d1/tasks/${id}`);
    }
  });
});

describe("the live progress line", () => {
  it("shows what the task last reported, from the log, and follows each new report without a reload", async () => {
    plane.tasks = [runningTask("r1")];
    plane.store("d1", "task.progress", { task_id: "r1", text: "Reading the first source" }, minutesAgo(2));
    plane.store("d1", "task.progress", { task_id: "other", text: "Not this task" }, minutesAgo(1));
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Running r1" });
    await waitFor(() => expect(within(card).getByText("Reading the first source")).toBeTruthy());
    expect(within(card).queryByText("Not this task")).toBeNull();
    expect(within(card).getByText("$0.12")).toBeTruthy();

    plane.tasks[0]!.spent_usd = 0.31;
    act(() => plane.push("d1", "task.progress", { task_id: "r1", text: "Writing the summary", spent_usd: 0.31 }));
    await waitFor(() => expect(within(card).getByText("Writing the summary")).toBeTruthy());
    expect(within(card).queryByText("Reading the first source")).toBeNull();
    await waitFor(() => expect(within(card).getByText("$0.31")).toBeTruthy());
    // One request for the newest report of that task; the second line came from the stream.
    expect(plane.eventQueries).toEqual([{ after: 0, limit: 1, types: ["task.progress"], tools: null, taskId: "r1", order: "desc" }]);
  });

  it("says plainly that a running task has not reported yet", async () => {
    plane.tasks = [runningTask("r1")];
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Running r1" });
    await waitFor(() => expect(within(card).getByText(/has not reported anything yet/)).toBeTruthy());
  });

  it("says so when the log cannot be read, and does not pretend the task is quiet", async () => {
    plane.tasks = [runningTask("r1")];
    plane.failEvents = 500;
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Running r1" });
    await waitFor(() => expect(within(card).getByText(/could not be read/)).toBeTruthy());
    expect(within(card).queryByText(/has not reported anything yet/)).toBeNull();
  });

  it("moves a task to the history when it ends, with its summary", async () => {
    plane.tasks = [runningTask("r1")];
    await renderTasks();
    await screen.findByRole("article", { name: "Running r1" });
    Object.assign(plane.tasks[0]!, { status: "COMPLETED", finished_at: new Date().toISOString(), summary: "Report written" });
    act(() => plane.push("d1", "task.completed", { task_id: "r1", summary: "Report written" }));
    const history = await screen.findByRole("region", { name: /^History/ });
    await waitFor(() => expect(within(history).getByText("Report written")).toBeTruthy());
    expect(screen.queryByRole("article", { name: "Running r1" })).toBeNull();
    expect(screen.getByText("Nothing is running.")).toBeTruthy();
  });

  it("shows the approval a task waits for as a card on the task, answers it there and keeps the receipt in place", async () => {
    plane.tasks = [runningTask("r1", { status: "WAITING_APPROVAL" }), runningTask("r2")];
    plane.approvals = [
      approvalRecord("a1", "d1", { task_id: "r1", tool: "write_file", permission: "files.write", arguments: { path: "report.md", content: "hello" }, reason: "to save the report" }),
      approvalRecord("a2", "d1", { task_id: "r2", tool: "exec", permission: "computer.exec", arguments: { command: "ls" } }),
    ];
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Running r1" });
    expect(within(card).getAllByText("Waiting for you").length).toBeGreaterThan(0);
    const approval = await within(card).findByRole("article", { name: "Wants to write a file" });
    expect(within(approval).getByText("to save the report")).toBeTruthy();
    // The other task's approval is on the other task's card.
    expect(within(card).queryByRole("article", { name: "Wants to run a command" })).toBeNull();
    expect(within(await screen.findByRole("article", { name: "Running r2" })).getByRole("article", { name: "Wants to run a command" })).toBeTruthy();

    await userEvent.click(within(approval).getByRole("button", { name: "Allow once" }));
    expect(plane.answers).toEqual([{ id: "a1", decision: "approve", body: {} }]);
    // The host no longer lists it as waiting, and the card still says what became of it.
    await waitFor(() => expect(within(card).getByRole("status").textContent).toBe("Allowed"));
    await waitFor(() => expect(plane.requests.filter((r) => r === "GET /api/approvals").length).toBeGreaterThan(1));
    expect(within(card).getByRole("status").textContent).toBe("Allowed");
  });

  it("shows the approval in the task's drawer too, above what happened", async () => {
    plane.tasks = [runningTask("r1", { status: "WAITING_APPROVAL" })];
    plane.approvals = [approvalRecord("a1", "d1", { task_id: "r1", tool: "exec", permission: "computer.exec", arguments: { command: "make test" } })];
    await renderTasks("r1");
    const drawer = await screen.findByRole("dialog", { name: "Running r1" });
    const approval = await within(drawer).findByRole("article", { name: "Wants to run a command" });
    expect(within(approval).getByText("make test")).toBeTruthy();
  });
});

describe("cancelling", () => {
  it("asks first, and does nothing when the person keeps the task", async () => {
    plane.tasks = [runningTask("r1")];
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Running r1" });
    await userEvent.click(within(card).getByRole("button", { name: /^Cancel/ }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this task?" });
    expect(dialog.textContent).toContain("The Dot stops working on it now");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(requested(/POST \/api\/tasks\//)).toEqual([]);
  });

  it("cancels once confirmed: the task leaves Running and shows in the history as cancelled", async () => {
    plane.tasks = [runningTask("r1")];
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Running r1" });
    await userEvent.click(within(card).getByRole("button", { name: /^Cancel/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(requested(/POST \/api\/tasks\/r1\/cancel/)).toHaveLength(1));
    const history = await screen.findByRole("region", { name: /^History/ });
    await waitFor(() => expect(within(history).getByText("Cancelled", { selector: "span" })).toBeTruthy());
    expect(screen.queryByRole("article", { name: "Running r1" })).toBeNull();
  });

  it("tells a queued task's consequence differently, and shows a refusal inside the dialog", async () => {
    plane.tasks = [taskRecord("q1", { description: "Wait in line" })];
    plane.failCancel = { status: 409, error: "task_finished", message: "task q1 is already COMPLETED" };
    await renderTasks();
    const card = await screen.findByRole("article", { name: "Wait in line" });
    await userEvent.click(within(card).getByRole("button", { name: /^Cancel/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("It will not run.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel task" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("task q1 is already COMPLETED");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the history", () => {
  function finished(count: number) {
    return Array.from({ length: count }, (_, i) =>
      taskRecord(`h${i}`, {
        description: `Finished ${i}`,
        status: i % 5 === 0 ? "FAILED" : i % 7 === 0 ? "CANCELLED" : "COMPLETED",
        finished_at: minutesAgo(i + 1),
        started_at: minutesAgo(i + 2),
        error: i % 5 === 0 ? "ran out of budget" : null,
      }),
    );
  }

  it("shows a page of twenty and the next twenty when asked", async () => {
    plane.tasks = finished(45);
    await renderTasks();
    const history = await screen.findByRole("region", { name: /^History/ });
    expect(within(history).getAllByRole("row")).toHaveLength(1 + 20);
    await userEvent.click(within(history).getByRole("button", { name: "Show 20 more" }));
    expect(within(history).getAllByRole("row")).toHaveLength(1 + 40);
    await userEvent.click(within(history).getByRole("button", { name: "Show 5 more" }));
    expect(within(history).getAllByRole("row")).toHaveLength(1 + 45);
    expect(within(history).queryByRole("button", { name: /Show/ })).toBeNull();
  });

  it("filters by how the tasks ended, and shows an error as the Dot gave it", async () => {
    plane.tasks = finished(12);
    await renderTasks();
    const history = await screen.findByRole("region", { name: /^History/ });
    await userEvent.click(within(history).getByRole("button", { name: "Failed" }));
    expect(within(history).getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe("true");
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(within(row).getByText("Failed")).toBeTruthy();
      expect(within(row).getByText("ran out of budget")).toBeTruthy();
    }
    await userEvent.click(within(history).getByRole("button", { name: "Cancelled" }));
    expect(within(history).getAllByRole("row")).toHaveLength(1 + 1);
    plane.tasks = [];
  });

  it("says when no finished task matches", async () => {
    plane.tasks = [taskRecord("h1", { status: "COMPLETED", finished_at: minutesAgo(1) })];
    await renderTasks();
    const history = await screen.findByRole("region", { name: /^History/ });
    await userEvent.click(within(history).getByRole("button", { name: "Failed" }));
    expect(within(history).getByText("No failed tasks.")).toBeTruthy();
  });
});

describe("New task", () => {
  async function openDialog() {
    await renderTasks();
    await screen.findByText("No tasks yet");
    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    return screen.findByRole("dialog", { name: "New task" });
  }

  it("will not send an empty description, and says why next to the field", async () => {
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(within(dialog).getByText("Say what the Dot should do.")).toBeTruthy();
    expect(within(dialog).getByLabelText("What should it do?").getAttribute("aria-invalid")).toBe("true");
    expect(plane.createdTasks).toEqual([]);
  });

  it("sends the description alone for a normal task, closes, and lists the new task", async () => {
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("What should it do?"), "  Collect the fares  ");
    expect(within(dialog).getByRole("radio", { name: "Normal" })).toHaveProperty("checked", true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(plane.createdTasks).toEqual([{ description: "Collect the fares" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("article", { name: "Collect the fares" })).toBeTruthy();
  });

  it("sends a named priority as its number, and a not-before time as an instant", async () => {
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("What should it do?"), "Check in the morning");
    await userEvent.click(within(dialog).getByRole("radio", { name: "High" }));
    const when = within(dialog).getByLabelText(/Not before/);
    await userEvent.type(when, "2030-05-01T09:30");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(plane.createdTasks).toHaveLength(1));
    expect(plane.createdTasks[0]).toEqual({ description: "Check in the morning", priority: 10, scheduled_at: new Date(2030, 4, 1, 9, 30).toISOString() });
  });

  it("keeps the raw number under Advanced, in step with the named choice, and refuses what is no number", async () => {
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("What should it do?"), "Urgent thing");
    expect(within(dialog).queryByLabelText("Priority as a number")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Advanced" }));
    const raw = within(dialog).getByLabelText("Priority as a number");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Urgent" }));
    expect((raw as HTMLInputElement).value).toBe("100");
    await userEvent.clear(raw);
    await userEvent.type(raw, "7");
    for (const radio of within(dialog).getAllByRole("radio")) expect(radio).toHaveProperty("checked", false);
    await userEvent.clear(raw);
    await userEvent.type(raw, "soon");
    expect(within(dialog).getByText("The priority is a whole number.")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(plane.createdTasks).toEqual([]);
    await userEvent.clear(raw);
    await userEvent.type(raw, "7");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(plane.createdTasks).toEqual([{ description: "Urgent thing", priority: 7 }]));
  });

  it("shows what the control plane refused, in the dialog, and keeps what was typed", async () => {
    plane.failCreateTask = { status: 400, error: "invalid", message: "the description is too long" };
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("What should it do?"), "A very long thing");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("the description is too long");
    expect((within(dialog).getByLabelText("What should it do?") as HTMLTextAreaElement).value).toBe("A very long thing");
  });

  it("starts empty again after it was closed without sending", async () => {
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("What should it do?"), "never mind");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "New task" }));
    expect((within(await screen.findByRole("dialog")).getByLabelText("What should it do?") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("the task drawer", () => {
  it("tells the whole story of a finished task: its steps, its result as markdown, its numbers", async () => {
    plane.tasks = [
      taskRecord("t1", {
        description: "Write the weekly report",
        status: "COMPLETED",
        priority: 10,
        started_at: minutesAgo(12),
        finished_at: minutesAgo(2),
        spent_usd: 0.73,
        summary: "Wrote **report.md** with [the numbers](https://example.com/n).",
      }),
    ];
    plane.store("d1", "task.created", { task_id: "t1", description: "Write the weekly report", priority: 10 }, minutesAgo(13));
    plane.store("d1", "task.started", { task_id: "t1" }, minutesAgo(12));
    plane.store("d1", "task.progress", { task_id: "t1", text: "Collecting the figures" }, minutesAgo(10));
    plane.store("d1", "tool.called", { task_id: "t1", tool: "exec", permission: "computer.exec", decision: "allow", ok: true, duration_ms: 2500, target: "python3 collect.py" }, minutesAgo(9));
    plane.store("d1", "approval.requested", { task_id: "t1", approval_id: "a1", tool: "write_file", permission: "files.write", reason: "to save report.md", arguments: {} }, minutesAgo(5));
    plane.store("d1", "approval.resolved", { task_id: "t1", approval_id: "a1", decision: "approve" }, minutesAgo(4));
    plane.store("d1", "task.completed", { task_id: "t1", summary: "x" }, minutesAgo(2));
    plane.store("d1", "task.progress", { task_id: "elsewhere", text: "Another task's line" }, minutesAgo(1));

    await renderTasks("t1");
    const drawer = await screen.findByRole("dialog", { name: "Write the weekly report" });
    await waitFor(() => expect(within(drawer).getByText("Collecting the figures")).toBeTruthy());
    expect(within(drawer).queryByText("Another task's line")).toBeNull();
    expect(within(drawer).getByText("python3 collect.py")).toBeTruthy();
    expect(within(drawer).getByText(/ok, 2s/)).toBeTruthy();
    expect(within(drawer).getByText(/Allowed:/)).toBeTruthy();
    // The engine's tool names are in the words of the chat (lib/events/tool-labels.ts), the name being the line's title.
    expect(within(drawer).getByText("Ran a command").getAttribute("title")).toBe("exec");
    expect(within(drawer).getByText("wrote a file").getAttribute("title")).toBe("write_file");
    expect(within(drawer).getByText("$0.73")).toBeTruthy();
    expect(within(drawer).getByText("High")).toBeTruthy();
    expect(within(drawer).getByText("10m 0s")).toBeTruthy();
    // The result is rendered, not shown as source.
    const result = within(drawer).getByRole("region", { name: "Result" });
    expect(result.querySelector("strong")?.textContent).toBe("report.md");
    expect(result.querySelector("a")?.getAttribute("href")).toBe("https://example.com/n");
    // A finished task cannot be cancelled.
    expect(within(drawer).queryByRole("button", { name: /^Cancel/ })).toBeNull();
    expect(requested(/GET \/api\/tasks\/t1$/)).toHaveLength(1);
    // Its story is read by the task: the rest of the Dot's log is not.
    expect(plane.eventQueries.length).toBeGreaterThan(0);
    expect(plane.eventQueries.every((q) => q.taskId === "t1")).toBe(true);
  });

  it("shows a failed task's reason as it was given, and a running task's story growing live", async () => {
    plane.tasks = [runningTask("t2", { description: "Long job" })];
    plane.store("d1", "task.started", { task_id: "t2" }, minutesAgo(3));
    await renderTasks("t2");
    const drawer = await screen.findByRole("dialog", { name: "Long job" });
    await waitFor(() => expect(within(drawer).getByText("The Dot started on it")).toBeTruthy());
    expect(within(drawer).getByRole("button", { name: /^Cancel/ })).toBeTruthy();

    act(() => plane.push("d1", "task.progress", { task_id: "t2", text: "Halfway through" }));
    await waitFor(() => expect(within(drawer).getByText("Halfway through")).toBeTruthy());

    Object.assign(plane.tasks[0]!, { status: "FAILED", finished_at: new Date().toISOString(), error: "the per-task cost cap was reached" });
    act(() => plane.push("d1", "task.failed", { task_id: "t2", error: "the per-task cost cap was reached" }));
    await waitFor(() => expect(within(drawer).getAllByText("the per-task cost cap was reached").length).toBeGreaterThan(0));
    await waitFor(() => expect(within(drawer).queryByRole("button", { name: /^Cancel/ })).toBeNull());
  });

  it("says when the task does not exist, and offers the way back", async () => {
    plane.tasks = [];
    await renderTasks("ghost");
    const drawer = await screen.findByRole("dialog");
    expect((await within(drawer).findByText("This task does not exist")).closest("[role=alert]")).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Back to the tasks" }).getAttribute("href")).toBe("/dots/d1/tasks");
  });

  it("treats a task of another Dot as missing under this Dot's address, and shows nothing of it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares" }), dotRecord("d2", { name: "mailer" })];
    plane.tasks = [taskRecord("theirs", { dot_id: "d2", description: "Their private errand", status: "COMPLETED", finished_at: minutesAgo(1), summary: "Their secret result" })];
    await renderTasks("theirs");
    const drawer = await screen.findByRole("dialog");
    expect((await within(drawer).findByText("This task does not exist")).closest("[role=alert]")).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "Back to the tasks" }).getAttribute("href")).toBe("/dots/d1/tasks");
    expect(screen.queryByText("Their private errand")).toBeNull();
    expect(screen.queryByText("Their secret result")).toBeNull();
    expect(within(drawer).queryByRole("button", { name: /^Cancel/ })).toBeNull();
  });

  it("says when the history cannot be read, and reads it again on request", async () => {
    plane.tasks = [taskRecord("t3", { description: "Quiet", status: "COMPLETED", finished_at: minutesAgo(1) })];
    plane.failEvents = 500;
    await renderTasks("t3");
    const drawer = await screen.findByRole("dialog", { name: "Quiet" });
    await within(drawer).findByText("Could not read the task's history");
    plane.failEvents = null;
    plane.store("d1", "task.started", { task_id: "t3" });
    await userEvent.click(within(drawer).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(drawer).getByText("The Dot started on it")).toBeTruthy());
  });

  it("goes back to the list when it is closed", async () => {
    plane.tasks = [taskRecord("t4", { description: "Close me", status: "COMPLETED", finished_at: minutesAgo(1) })];
    await renderTasks("t4");
    const drawer = await screen.findByRole("dialog", { name: "Close me" });
    await userEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(router.push).toHaveBeenCalledWith("/dots/d1/tasks");
  });
});

describe("the Dot header while a task runs", () => {
  it("shows the newest thing the task reported, linked to the task", async () => {
    plane.tasks = [runningTask("r1")];
    await renderTasks();
    await screen.findByRole("article", { name: "Running r1" });
    act(() => plane.push("d1", "task.progress", { task_id: "r1", text: "Comparing the fares" }));
    const line = await screen.findByRole("link", { name: /Comparing the fares/ });
    expect(line.getAttribute("href")).toBe("/dots/d1/tasks/r1");
    act(() => plane.push("d1", "task.completed", { task_id: "r1", summary: "done" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Comparing the fares/ })).toBeNull());
  });
});
