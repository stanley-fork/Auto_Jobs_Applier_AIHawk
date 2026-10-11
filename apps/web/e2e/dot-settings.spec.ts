import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { lookOf } from "./look.js";

const settings = (webUrl: string, dotId: string) => `${webUrl}/dots/${dotId}/settings`;
const row = (page: Page, label: string) => page.getByRole("group", { name: label });
/** The segmented control is three radios in labels; the label is what a person presses. */
const choose = (page: Page, label: string, decision: "Allow" | "Ask" | "Deny") => row(page, label).locator("label", { hasText: decision }).click();

async function saveReviewed(page: Page) {
  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
}

test("allow, ask and deny a permission: the host saves one entry, the Dot's engine has it, and the tools it offers follow", async ({ page, harness }) => {
  const dot = await harness.createDot("config-perms");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(settings(harness.webUrl, dot.id));

  // The tools of a permission, from the Dot's own table, offered while the permission is not denied.
  const exec = page.getByRole("list", { name: "Tools of Run commands" });
  await expect(exec.getByRole("listitem")).toHaveText(["exec"]);

  // Deny: saved as an entry, pushed, and the model is no longer offered the tool.
  await choose(page, "Run commands", "Deny");
  await expect(row(page, "Run commands").getByRole("radio", { name: "Deny" })).toBeChecked();
  await expect(page.getByText("1 unsaved change.")).toBeVisible();
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({});
  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await expect(dialog.getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveText(["Run commandsfrom allow to deny"]);
  // Still nothing written: the review is not the save.
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({});
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved. The change applies from the Dot's next turn.")).toBeVisible();
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({ "computer.exec": "deny" });
  await expect.poll(() => guest.config?.permissions["computer.exec"]).toBe("deny");
  expect((await harness.api.listTools(dot.id)).tools.find((tool) => tool.name === "exec")?.offered).toBe(false);
  await expect(exec.getByRole("listitem")).toHaveText(["execnot offered"]);

  // Ask: the tool is offered again, and the Dot will wait for an answer.
  await choose(page, "Run commands", "Ask");
  await saveReviewed(page);
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({ "computer.exec": "ask" });
  await expect.poll(() => guest.config?.permissions["computer.exec"]).toBe("ask");
  await expect(exec.getByRole("listitem")).toHaveText(["exec"]);

  // Allow is what the default says: the entry goes, the engine still allows.
  await choose(page, "Run commands", "Allow");
  await saveReviewed(page);
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({});
  await expect.poll(() => guest.config?.permissions["computer.exec"]).toBe("allow");

  // A reload shows what is saved.
  await page.reload();
  await expect(row(page, "Run commands").getByRole("radio", { name: "Allow" })).toBeChecked();
  await expect(row(page, "Automations").getByRole("radio", { name: "Ask" })).toBeChecked();
});

test("an MCP server is added in the settings, its secret reaches the Dot's engine and never the page, and its state shows", async ({ page, harness }) => {
  const dot = await harness.createDot("config-mcp");
  const guest = harness.driver.guestOf(dot.id);
  guest.mcpTools.set("search", [{ name: "mcp_search_query", description: "Search." }]);
  await page.goto(settings(harness.webUrl, dot.id));
  const panel = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "MCP servers" }) });

  await panel.getByRole("button", { name: "Add an MCP server" }).click();
  const form = page.getByRole("form", { name: "New MCP server" });
  await form.getByLabel("Name").fill("search");
  await form.getByText("A URL").click();
  await form.getByRole("textbox", { name: "URL" }).fill("https://search.example/mcp");
  await form.getByLabel(/^Secrets/).fill("Authorization");
  await form.getByRole("button", { name: "Add" }).click();
  await saveReviewed(page);
  await expect.poll(async () => (await harness.api.getDot(dot.id)).config.mcp_servers).toEqual({
    search: { url: "https://search.example/mcp", headers: {}, secrets: ["Authorization"], timeout_s: 120 },
  });

  // Saved, the server's secret can be set; the engine gets it, the page keeps nothing of it.
  const secret = panel.getByLabel("Authorization");
  await secret.fill("Bearer e2e-token");
  await panel.getByRole("button", { name: "Set" }).click();
  await expect(secret).toHaveValue("");
  await expect.poll(() => guest.mcpSecrets).toEqual({ search: { Authorization: "Bearer e2e-token" } });
  expect(await page.content()).not.toContain("e2e-token");

  // Where it is, as the engine says, and its permission among the others, asked by default.
  await expect(panel.getByText("Connected, 1 tool")).toBeVisible();
  await expect(row(page, "MCP server search").getByRole("radio", { name: "Ask" })).toBeChecked();
  await expect(page.getByRole("list", { name: "Tools of MCP server search" }).getByRole("listitem")).toHaveText(["mcp_search_query"]);
});

test("a preset sets the rows together, and the review lists every row that moved", async ({ page, harness }) => {
  const dot = await harness.createDot("config-preset");
  await page.goto(settings(harness.webUrl, dot.id));
  await page.getByRole("radio", { name: /Careful/ }).check();
  await expect(row(page, "Run commands").getByRole("radio", { name: "Ask" })).toBeChecked();
  await expect(row(page, "Change files").getByRole("radio", { name: "Ask" })).toBeChecked();
  await page.getByRole("button", { name: "Review and save" }).click();
  await expect(page.getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveText(["Run commandsfrom allow to ask", "Change filesfrom allow to ask"]);
  await page.getByRole("button", { name: "Keep editing" }).click();
  // Keep editing sends nothing, and the edits stay.
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({});
  await expect(row(page, "Run commands").getByRole("radio", { name: "Ask" })).toBeChecked();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(row(page, "Run commands").getByRole("radio", { name: "Allow" })).toBeChecked();
  await expect(page.getByText("No changes.")).toBeVisible();
});

test("the other settings are saved with the permissions: the summary model, the spending cap and the step limit", async ({ page, harness }) => {
  const dot = await harness.createDot("config-rest");
  const guest = harness.driver.guestOf(dot.id);
  await page.goto(settings(harness.webUrl, dot.id));
  await page.getByLabel(/^Summary model/).fill("openai/gpt-5-mini");
  await page.getByLabel("Spending cap per task").fill("0.5");
  await page.getByLabel("Steps per task").fill("25");
  await choose(page, "Delete browser identities", "Deny");
  await expect(page.getByText("4 unsaved changes.")).toBeVisible();
  await saveReviewed(page);

  const config = (await harness.api.getDot(dot.id)).config;
  expect(config.models).toEqual({ summary: "openai/gpt-5-mini" });
  expect(config.limits).toMatchObject({ max_cost_per_task_usd: 0.5, max_steps_per_task: 25 });
  expect("browser" in config).toBe(false);
  // There is no memory to set: the Dot keeps its notes itself.
  expect("memory" in config).toBe(false);
  await expect(page.getByRole("switch", { name: /^Memory/ })).toHaveCount(0);
  expect(config.permissions).toEqual({ "browser.identity.delete": "deny" });
  await expect.poll(() => guest.config?.models.summary).toBe("openai/gpt-5-mini");

  // Emptying the summary model takes the role out of the config.
  await page.getByLabel(/^Summary model/).fill("");
  await saveReviewed(page);
  expect((await harness.api.getDot(dot.id)).config.models).toEqual({});
});

test("a setting that is wrong is said where it is, and the disk cannot shrink", async ({ page, harness }) => {
  const dot = await harness.createDot("config-rules");
  await page.goto(settings(harness.webUrl, dot.id));
  await page.getByRole("combobox", { name: "Model", exact: true }).fill("two words");
  await expect(page.getByText("model id must not contain whitespace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review and save" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Model", exact: true }).fill("openai/gpt-5");
  await expect(page.getByRole("button", { name: "Review and save" })).toBeEnabled();
  await page.getByRole("button", { name: "Discard changes" }).click();

  // The slider starts at what the disk is; the host refuses a smaller disk from the YAML, with its own words.
  await expect(page.getByLabel("Disk", { exact: true })).toHaveAttribute("min", "40");
  await page.getByRole("button", { name: "Advanced YAML" }).click();
  const yaml = page.getByRole("textbox", { name: "Configuration (YAML)" });
  await yaml.fill((await yaml.inputValue()).replace(/disk: "?40gb"?/, 'disk: "30gb"'));
  await page.getByRole("button", { name: "Review and save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  const refusal = page.getByRole("dialog").getByRole("alert");
  await expect(refusal).toContainText("The configuration was not saved");
  await expect(refusal).toContainText("computer.disk cannot shrink from 40gb to 30gb");
  expect((await harness.api.getDot(dot.id)).config.computer.disk).toBe("40gb");
});

test("the YAML view is the same config: the form's edits are in it, and what it says is what is saved", async ({ page, harness }) => {
  const dot = await harness.createDot("config-yaml");
  await page.goto(settings(harness.webUrl, dot.id));
  await choose(page, "Change files", "Ask");
  await page.getByRole("button", { name: "Advanced YAML" }).click();
  const yaml = page.getByRole("textbox", { name: "Configuration (YAML)" });
  await expect(yaml).toHaveValue(/files\.write: ask/);
  await yaml.fill((await yaml.inputValue()).replace("max_steps_per_task: 60", "max_steps_per_task: 15"));
  await expect(page.getByText("2 unsaved changes.")).toBeVisible();
  await saveReviewed(page);
  const config = (await harness.api.getDot(dot.id)).config;
  expect(config.limits.max_steps_per_task).toBe(15);
  expect(config.permissions).toEqual({ "files.write": "ask" });

  // A text that is not a config says what is wrong, cannot be saved, and keeps the person in the YAML.
  await yaml.fill("name: [unclosed");
  await expect(page.getByRole("list", { name: "Problems in the YAML" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review and save" })).toBeDisabled();
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await expect(page.getByText("The form cannot show this")).toBeVisible();
});

test("a config changed elsewhere while the page is open is never undone: the edits are kept on top of it, and the save is conditional on what the page read", async ({ page, harness }) => {
  const dot = await harness.createDot("config-stale");
  await page.goto(settings(harness.webUrl, dot.id));
  await choose(page, "Run commands", "Deny");

  // "Always allow" in another tab, which is the API here: the page hears it and keeps the edit on top of it.
  const read = await harness.api.getDot(dot.id);
  await harness.api.updateDot(dot.id, { ...read.config, permissions: { automations: "allow" } });
  await expect(page.getByText("The configuration changed while you were editing")).toBeVisible();
  await expect(row(page, "Automations").getByRole("radio", { name: "Allow" })).toBeChecked();
  await expect(row(page, "Run commands").getByRole("radio", { name: "Deny" })).toBeChecked();
  await expect(page.getByText("1 unsaved change.")).toBeVisible();
  await saveReviewed(page);
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({ automations: "allow", "computer.exec": "deny" });
  await expect(page.getByText("The configuration changed while you were editing")).toHaveCount(0);
});

test("a stopped computer says the tools need it running, and the permissions can still be set", async ({ page, harness }) => {
  const dot = await harness.createDot("config-stopped");
  await harness.api.stopComputer(dot.id);
  await page.goto(settings(harness.webUrl, dot.id));
  await expect(page.getByRole("button", { name: /^Computer: Stopped/ })).toBeVisible();
  await expect(page.getByText(/Start the computer to see the tools each permission covers/)).toBeVisible();
  await expect(page.getByRole("list", { name: /^Tools of/ })).toHaveCount(0);
  await choose(page, "Run commands", "Ask");
  await saveReviewed(page);
  expect((await harness.api.getDot(dot.id)).config.permissions).toEqual({ "computer.exec": "ask" });
  await expect(page.getByText("Saved. The Dot gets the change when its computer starts.")).toBeVisible();
});

test("delete asks for the Dot's name, and the Dot is gone after it", async ({ page, harness }) => {
  const dot = await harness.createDot("config-delete");
  await page.goto(settings(harness.webUrl, dot.id));
  await page.getByRole("button", { name: "Delete Dot" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete config-delete?" });
  const confirm = dialog.getByRole("button", { name: "Delete Dot" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type config-delete to confirm/).fill("config-delet");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type config-delete to confirm/).fill("config-delete");
  await confirm.click();
  await expect(page).toHaveURL(`${harness.webUrl}/`);
  await expect.poll(async () => (await harness.api.listDots()).some((d) => d.id === dot.id)).toBe(false);
});

test("the settings page is usable from the keyboard alone, and fits a phone", async ({ page, harness }) => {
  const dot = await harness.createDot("config-keys");
  await page.goto(settings(harness.webUrl, dot.id));
  // The arrow keys walk the three decisions of a row.
  await row(page, "Read files").getByRole("radio", { name: "Allow" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Read files").getByRole("radio", { name: "Ask" })).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Read files").getByRole("radio", { name: "Deny" })).toBeChecked();
  await page.getByRole("button", { name: "Review and save" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Save these changes?" });
  await expect(dialog.getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveText(["Read filesfrom allow to deny"]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(settings(harness.webUrl, dot.id));
  await expect(page.getByRole("heading", { name: "Permissions and tools" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await choose(page, "Run commands", "Ask");
  // The bar with the save button stays in reach while the long page scrolls.
  await expect(page.getByRole("button", { name: "Review and save" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the settings are readable in ${scheme}: the rows, the risk and change marks, the tools, the save bar`, async ({ page, harness }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const dot = await harness.createDot(`config-look-${scheme}`);
    await page.goto(settings(harness.webUrl, dot.id));
    await choose(page, "Run commands", "Deny");
    await expect(page.getByRole("list", { name: "Tools of Run commands" })).toBeVisible();
    await page.getByRole("combobox", { name: "Model", exact: true }).fill("two words");
    await expect(page.getByText("model id must not contain whitespace")).toBeVisible();

    const spots: Record<string, string> = {
      "a permission's description": "li:has(fieldset legend:text-is('Run commands')) > div p.text-sm",
      "a decision that is not chosen": "li:has(legend:text-is('Read files')) label:has(input:not(:checked))",
      "the decision that is chosen": "li:has(legend:text-is('Run commands')) label:has(input:checked)",
      "the high risk mark": "li:has(legend:text-is('Run commands')) span:text-is('High risk')",
      "the medium risk mark": "li:has(legend:text-is('Change files')) span:text-is('Medium risk')",
      "the low risk mark": "li:has(legend:text-is('Read files')) span:text-is('Low risk')",
      "the changed mark": "li:has(legend:text-is('Run commands')) span:text-is('Changed')",
      "what a decision means": "li:has(legend:text-is('Run commands')) > p.text-xs",
      "a field's problem": "p.text-danger",
      "the save bar's text": "[aria-label=Save] p",
    };
    for (const [name, selector] of Object.entries(spots)) {
      expect((await lookOf(page, selector)).contrast, name).toBeGreaterThanOrEqual(4.5);
    }
  });
}
