import assert from "node:assert/strict";
import test from "node:test";

import { Screen } from "../../src/cli/screen.js";
import {
  Container,
  isWheelDown,
  isWheelUp,
  parseSgrMouseEvent,
  Text,
  TuiMainScreen,
  type Terminal,
} from "../../src/tui/index.js";

/** A terminal that records what was drawn instead of drawing it. */
class FakeTerminal implements Terminal {
  written = "";
  columns = 80;
  rows = 10;
  kittyProtocolActive = false;
  #input: ((data: string) => void) | null = null;

  start(onInput: (data: string) => void): void {
    this.#input = onInput;
  }
  stop(): void {
    this.#input = null;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  /** Deliver input exactly as the terminal would. */
  press(data: string): void {
    assert.ok(this.#input !== null, "terminal was not started");
    this.#input(data);
  }
}

/** A TUI showing forty numbered lines in a ten-row terminal. */
function tallTui(t: { after: (fn: () => void) => void }): {
  tui: TuiMainScreen;
  terminal: FakeTerminal;
  drawn: () => string;
} {
  const terminal = new FakeTerminal();
  const tui = new TuiMainScreen(terminal, false, "/tmp/flashcoder-tui-test");
  const body = new Container();
  tui.addChild(body);
  for (let i = 0; i < 40; i++) {
    body.addChild(new Text(`line ${i}`, 1, 0));
  }
  t.after(() => {
    tui.stop();
  });
  return {
    tui,
    terminal,
    // Each call renders and returns only what this render wrote.
    drawn: () => {
      tui.renderNow();
      const out = terminal.written;
      terminal.written = "";
      return out;
    },
  };
}

test("SGR wheel reports parse into up/down buttons", () => {
  const up = parseSgrMouseEvent("\x1b[<64;5;5M");
  assert.ok(up !== null);
  assert.ok(isWheelUp(up));
  assert.ok(!isWheelDown(up));
  assert.equal(up.x, 5);
  assert.equal(up.y, 5);
  assert.ok(up.press);

  const down = parseSgrMouseEvent("\x1b[<65;3;9M");
  assert.ok(down !== null);
  assert.ok(isWheelDown(down));
  assert.ok(!isWheelUp(down));

  const click = parseSgrMouseEvent("\x1b[<0;1;1M");
  assert.ok(click !== null);
  assert.ok(!isWheelUp(click));
  assert.ok(!isWheelDown(click));
  assert.equal(click.button, 0);

  const release = parseSgrMouseEvent("\x1b[<0;1;1m");
  assert.ok(release !== null);
  assert.ok(!release.press);
});

test("the first render writes every row, newest last", (t) => {
  const { drawn } = tallTui(t);
  const output = drawn();
  assert.match(output, /line 0/u);
  assert.match(output, /line 39/u);
  // The newest row is the last one written, so the terminal shows it at the
  // bottom and everything else lives in scrollback.
  assert.ok(output.indexOf("line 39") > output.indexOf("line 0"));
});

test("scrolling back shows a history window without clearing scrollback", (t) => {
  const { tui, drawn } = tallTui(t);
  drawn(); // settle on the newest rows
  tui.scrollBy(10);
  const output = drawn();
  // The window moved ten rows up...
  assert.match(output, /line 20/u);
  assert.match(output, /line 29/u);
  assert.doesNotMatch(output, /line 39/u);
  // ...by clearing the screen (ED2) but never the scrollback (no ED3).
  assert.match(output, /\x1b\[2J/u);
  assert.doesNotMatch(output, /\x1b\[3J/u);
});

test("scrollToTop reaches the first rows, scrollToBottom comes home", (t) => {
  const { tui, drawn } = tallTui(t);
  drawn();
  assert.ok(!tui.isScrolled());

  tui.scrollToTop();
  const top = drawn();
  assert.match(top, /line 0/u);
  assert.match(top, /line 9/u);
  assert.doesNotMatch(top, /line 39/u);
  assert.ok(tui.isScrolled());

  tui.scrollToBottom();
  const bottom = drawn();
  assert.match(bottom, /line 30/u);
  assert.match(bottom, /line 39/u);
  assert.doesNotMatch(bottom, /line 9/u);
  assert.ok(!tui.isScrolled());
});

test("content growing while scrolled keeps the reader where they are", (t) => {
  const { tui, drawn } = tallTui(t);
  drawn();
  tui.scrollBy(10);
  drawn(); // window is rows 20..29
  // Append two rows: the window slides to rows 22..31 (ten back from the new
  // end) and only the changed rows are redrawn.
  const body = (tui as unknown as { children: Container[] }).children?.[0] as Container;
  body.addChild(new Text("line 40", 1, 0));
  body.addChild(new Text("line 41", 1, 0));
  const delta = drawn();
  assert.match(delta, /line 29/u);
  assert.doesNotMatch(delta, /line 39/u);
  assert.ok(tui.isScrolled(), "new content must not yank the reader to the bottom");
});

function screenWithHistory(t: { after: (fn: () => void) => void }): {
  screen: Screen;
  terminal: FakeTerminal;
  drawn: () => string;
} {
  const terminal = new FakeTerminal();
  const instance = new Screen({
    workspaceRoot: process.cwd(),
    commands: [{ name: "help", description: "keys and commands" }],
    terminal,
  });
  t.after(() => {
    instance.stop();
  });
  const drawn = (): string => {
    instance.renderNow();
    const out = terminal.written;
    terminal.written = "";
    return out;
  };
  for (let i = 0; i < 30; i++) {
    instance.say(`history ${i}`);
  }
  instance.attach({
    onSubmit: () => {},
    onInterrupt: () => {},
    onExit: () => {},
  });
  instance.start();
  return { screen: instance, terminal, drawn };
}

test("highlight lands on the selected screen row in the non-scroll viewport", (t) => {
  const { tui, terminal, drawn } = tallTui(t);
  drawn(); // settle: rows 30..39 visible, viewportTop 30
  // Select screen row 0 (content line 30). The next render must draw the
  // reverse-video highlight on the row under the cursor, not on content
  // line 0 which scrolled off screen long ago.
  tui.beginSelection(0, 1);
  tui.extendSelection(0, 7);
  terminal.written = "";
  const highlighted = drawn();
  assert.match(highlighted, /\x1b\[7mline 3\x1b\[27m/u);
  tui.endSelection();
  drawn();
});

test("mouse selection maps the screen row through the viewport top", (t) => {
  const { tui, terminal, drawn } = tallTui(t);
  drawn(); // settle: rows 30..39 are on screen, viewportTop is 30
  // Select the top visible row (screen row 0) through one character.
  tui.beginSelection(0, 1);
  tui.extendSelection(0, 7);
  const text = tui.endSelection();
  // The top visible row is content line 30, not line 0. Column 0 is the
  // one-cell padding, so columns 1..6 are the text "line 3".
  assert.equal(text, "line 3");
  // The highlighted render rewrote the selected row.
  terminal.written = "";
  tui.beginSelection(0, 1);
  tui.extendSelection(0, 7);
  const highlighted = drawn();
  assert.match(highlighted, /line 3/u);
  tui.endSelection();
  drawn();
});

test("scrollSelection reveals more content while dragging past the top edge", (t) => {
  const { tui, drawn } = tallTui(t);
  drawn(); // settle: rows 30..39 visible
  // Anchor on the top visible row, then auto-scroll up twice.
  tui.beginSelection(0, 1);
  const first = tui.scrollSelection(1, 1);
  assert.ok(first, "older content is revealed");
  const second = tui.scrollSelection(1, 1);
  assert.ok(second, "more older content is revealed");
  // The selection now spans from the original anchor (line 30) up to the
  // newly visible top row (line 28).
  const text = tui.endSelection();
  assert.ok(text !== null, "selection spans multiple lines");
  const lines = (text as string).split("\n");
  assert.ok(lines.length >= 3, `expected 3+ lines, got ${lines.length}: ${text}`);
  assert.match(lines[0] ?? "", /line 2/u);
  // No more scrolling once the top of the content is reached.
  tui.scrollToTop();
  drawn();
  tui.beginSelection(0, 1);
  const exhausted = tui.scrollSelection(1, 1);
  assert.ok(!exhausted, "top of content stops auto-scroll");
  tui.endSelection();
  drawn();
});

test("a wheel report scrolls the transcript, a click does not type", (t) => {
  const { terminal, drawn } = screenWithHistory(t);
  drawn(); // settle
  terminal.written = "";
  // Wheel up: the transcript scrolls back one notch.
  terminal.press("\x1b[<64;20;5M");
  const scrolled = drawn();
  assert.match(scrolled, /\x1b\[2J/u);
  assert.doesNotMatch(scrolled, /\x1b\[3J/u);
  // A click is consumed and types nothing into the editor.
  terminal.written = "";
  terminal.press("\x1b[<0;1;1M");
  terminal.press("\x1b[<0;1;1m");
  const clicked = drawn();
  assert.doesNotMatch(clicked, /u/u);
  assert.doesNotMatch(clicked, /[a-z]/u);
});

test("typing while scrolled drops back to the newest content", (t) => {
  const { terminal, drawn } = screenWithHistory(t);
  drawn();
  terminal.press("\x1b[<64;20;5M"); // scroll up
  drawn();
  terminal.written = "";
  terminal.press("x"); // type a character
  const output = drawn();
  // The editor and the newest transcript rows are back on screen.
  assert.match(output, /x/u);
  assert.match(output, /history 29/u);
});
