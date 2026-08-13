import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  type Component,
  type SlashCommand,
  isKeyRelease,
  isWheelDown,
  isWheelUp,
  matchesKey,
  parseSgrMouseEvent,
  type Terminal,
  type TuiInputListenerResult,
} from "../tui/index.js";
import { color, editorTheme, markdownTheme } from "./theme.js";

const CTRL_C = "\u0003";
const ENTER = "\r";
const CTRL_D = "\u0004";
const ESCAPE = "\u001b";

/** Rows one wheel notch scrolls, matching the feel of prime-agent. */
const WHEEL_SCROLL_LINES = 3;
/** Delay before edge auto-scroll starts, and the interval between its steps. */
const SELECTION_AUTO_SCROLL_DELAY_MS = 150;
const SELECTION_AUTO_SCROLL_INTERVAL_MS = 50;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 90;

interface Activity {
  readonly label: string;
  readonly paint: (text: string) => string;
}

export interface ScreenHandlers {
  /** Enter on a non-empty line. */
  readonly onSubmit: (text: string) => void;
  /** A level chosen on the slider, or null when it was dismissed. */
  readonly onPick?: (value: string | null) => void;
  /** A row chosen in the picker by index, or null when it was dismissed. */
  readonly onChoose?: (index: number | null) => void;
  /** Ctrl-C, or Escape while a turn is running. */
  readonly onInterrupt: () => void;
  /** Ctrl-D on an empty line. */
  readonly onExit: () => void;
}

export interface ScreenOptions {
  readonly workspaceRoot: string;
  readonly commands: readonly SlashCommand[];
  /** Injected by tests; the real loop uses the process terminal. */
  readonly terminal?: Terminal;
}

/**
 * Keys the interactive layer claims for itself.
 *
 * Each accepts both encodings: the control byte a plain terminal sends, and the
 * CSI-u form the terminal sends once the TUI has negotiated the Kitty keyboard
 * protocol. Only one of the two ever arrives, and which one is not this layer's
 * decision.
 */
const isEnter = (data: string): boolean =>
  matchesKey(data, "enter") || data === ENTER;
const isEscape = (data: string): boolean =>
  matchesKey(data, "escape") || data === ESCAPE;
const isCtrlC = (data: string): boolean =>
  matchesKey(data, "ctrl+c") || data === CTRL_C;

function firstLine(text: string, limit: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Model, effort and directory, narrowed until they fit.
 *
 * The path is what gives way, one leading segment at a time, because a wrapped
 * footer costs a whole row of transcript and the model and effort are the two
 * facts that change what the next turn does.
 */
function describeContext(
  context: Readonly<{ model: string; effort: string; directory: string }>,
  room: number,
): string {
  const head = `${context.model} · ${context.effort}`;
  const segments = context.directory.split("/").filter((part) => part !== "");
  let shortest = Number.POSITIVE_INFINITY;
  for (let dropped = 0; dropped < segments.length; dropped += 1) {
    const shown =
      dropped === 0 ? context.directory : `…/${segments.slice(dropped).join("/")}`;
    // Replacing a one-character segment with the ellipsis makes the path
    // longer, so skip any step that does not actually buy a column.
    if (shown.length >= shortest) continue;
    shortest = shown.length;
    const line = `${head} · ${shown}`;
    if (line.length <= room) return line;
  }
  return head.length <= room ? head : context.model;
}

/**
 * Everything the interactive loop draws.
 *
 * The screen is a component tree under one differential renderer: a transcript
 * that only grows, the queue of messages waiting to be sent, a status row, the
 * editor, and a footer holding the ledger. Nothing here knows about Sessions —
 * it is told what to show.
 */
export class Screen {
  readonly #tui: TuiMainScreen;
  readonly #editor: Editor;
  readonly #transcript = new Container();
  readonly #pending = new Container();
  readonly #status = new Text("", 1, 0);
  readonly #footer = new Text("", 1, 0);
  #stream: Markdown | null = null;
  #streamText = "";
  #ledger = "";
  #context: Readonly<{ model: string; effort: string; directory: string }> | null =
    null;
  #queued = 0;
  #activity: Activity | null = null;
  #spinner: NodeJS.Timeout | null = null;
  #spinnerFrame = 0;
  #detachInput: (() => void) | null = null;
  #slider: Readonly<{ label: string; stops: readonly string[]; at: number }> | null = null;
  #picker: Readonly<{
    label: string;
    rows: readonly string[];
    at: number;
  }> | null = null;
  /**
   * Whether a tmux setup hint should be shown: the probe said the tmux
   * `mouse` option is off (or could not be read). With it off neither the
   * wheel nor click-drag works in tmux.
   */
  #tmuxWheelHint = false;
  #attached = false;
  /** Timer that keeps auto-scrolling while the drag rests on an edge. */
  #selectionAutoScrollTimer: ReturnType<typeof setTimeout> | null = null;
  #selectionAutoScrollDirection: 1 | -1 | null = null;
  #selectionAutoScrollCol = 0;
  readonly #commandNames: ReadonlySet<string>;

  constructor(options: ScreenOptions) {
    this.#commandNames = new Set(options.commands.map(({ name }) => `/${name}`));
    if (process.env["TMUX"]) this.#probeTmuxMouse();
    // Where the renderer writes its own diagnostics if it ever crashes. Beside
    // the credentials rather than in the workspace, which belongs to the user
    // and is usually under version control.
    this.#tui = new TuiMainScreen(
      options.terminal ?? new ProcessTerminal(),
      // Show the terminal's own cursor at the edit point. It sits on the same
      // cell as the drawn block, so the caret blinks the way every other input
      // on the machine does, without a repaint timer running while idle.
      true,
      join(homedir(), ".config", "dsh", "tui"),
    );
    this.#editor = new Editor(this.#tui, editorTheme, {
      paddingX: 4,
      prompt: ">",
      promptColor: color.tool,
      frame: true,
    });
    this.#editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [...options.commands],
        options.workspaceRoot,
      ),
    );
    this.#tui.addChild(this.#transcript);
    this.#tui.addChild(this.#pending);
    this.#tui.addChild(this.#status);
    this.#tui.addChild(this.#editor);
    this.#tui.addChild(this.#footer);
    this.#tui.setFocus(this.#editor);
  }

  /**
   * Append to the transcript.
   *
   * This also ends the open streaming block, so whatever the model says next
   * starts below the line just added rather than growing back into it.
   */
  #append(component: Component): void {
    this.#stream = null;
    this.#transcript.addChild(component);
    this.#tui.requestRender();
  }

  /** One finished line of transcript. */
  say(text: string): void {
    this.#append(new Text(text, 1, 0));
  }

  /**
   * A line that spans the terminal edge to edge.
   *
   * Transcript lines are inset by a column so they do not crowd the border; a
   * border is the one thing that has to sit on the edge itself, or the opening
   * box and the box around the editor come out a column apart.
   */
  wide(text: string): void {
    this.#append(new Text(text, 0, 0));
  }

  /**
   * Empty the visible transcript.
   *
   * The screen is a projection, so this discards nothing: the Session, its byte
   * prefix and every durable fact are untouched, and the next turn continues
   * exactly where this one left off. It is a way to stop scrolling past work
   * you are done reading, not a way to forget it.
   */
  clearTranscript(): void {
    this.#stream = null;
    this.#streamText = "";
    this.#transcript.clear();
    this.#tui.requestRender(true);
  }

  /** A finished block of the model's own prose, rendered as Markdown. */
  markdown(text: string): void {
    this.#append(new Markdown(text, 1, 0, markdownTheme));
  }

  blank(): void {
    this.#append(new Spacer(1));
  }

  /**
   * Extend the block the model is currently writing.
   *
   * Deltas arrive without line boundaries, so the whole block is re-rendered as
   * Markdown each time; the renderer redraws only the rows that changed.
   */
  stream(delta: string): void {
    if (this.#stream === null) {
      this.#streamText = "";
      this.#stream = new Markdown("", 1, 0, markdownTheme);
      this.#transcript.addChild(this.#stream);
    }
    this.#streamText += delta;
    this.#stream.setText(this.#streamText);
    this.#tui.requestRender();
  }

  /** Messages typed while a turn was running, shown in the order they will be sent. */
  setPending(items: readonly string[]): void {
    this.#pending.clear();
    for (const item of items) {
      this.#pending.addChild(
        new Text(color.dim(`> ${firstLine(item, 72)}`), 1, 0),
      );
    }
    this.#queued = items.length;
    this.#refreshFooter();
  }

  /** Cost, cache and context, already formatted and unpainted. */
  setLedger(text: string): void {
    this.#ledger = text;
    this.#refreshFooter();
  }

  /**
   * Model, effort and working directory.
   *
   * Kept as fields rather than a finished string because the footer has to fit
   * the terminal: when the ledger arrives beside it, the path is what gives way.
   */
  setContext(model: string, effort: string, directory: string): void {
    this.#context = Object.freeze({ model, effort, directory });
    this.#refreshFooter();
  }

  #refreshFooter(): void {
    const queued =
      this.#queued === 0 ? "" : ` · ${String(this.#queued)} queued`;
    const room = Math.max(20, this.#tui.terminal.columns - 2);
    const spent = this.#ledger.length + queued.length + (this.#ledger === "" ? 0 : 3);
    const context =
      this.#context === null
        ? ""
        : describeContext(this.#context, Math.max(0, room - spent));
    const parts = [context, this.#ledger].filter((part) => part.length > 0);
    this.#footer.setText(color.dim(`${parts.join(" · ")}${queued}`));
    this.#tui.requestRender();
  }

  /** A transient line above the editor. Replaced by whichever spinner is up. */
  note(text: string): void {
    if (this.#activity !== null) return;
    this.#status.setText(text.length === 0 ? "" : color.dim(text));
    this.#tui.requestRender();
  }

  /**
   * Turn the status row into a spinner, or clear it.
   *
   * One spinner, two meanings. Both use the same braille frames so the shape is
   * familiar; the colour is what says which one is running, because compaction
   * behaves differently — it is not the model working on your request, and
   * interrupting it leaves the conversation as it was.
   */
  #spin(activity: Activity | null): void {
    if (activity?.label === this.#activity?.label) return;
    this.#activity = activity;
    if (this.#spinner !== null) clearInterval(this.#spinner);
    this.#spinner = null;
    if (activity === null) {
      this.#status.setText("");
      this.#tui.requestRender();
      return;
    }
    this.#spinnerFrame = 0;
    const tick = (): void => {
      this.#status.setText(
        `${activity.paint(SPINNER[this.#spinnerFrame] ?? "")} ${color.dim(activity.label)}`,
      );
      this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER.length;
      this.#tui.requestRender();
    };
    tick();
    this.#spinner = setInterval(tick, SPINNER_INTERVAL_MS);
    this.#spinner.unref();
  }

  setWorking(working: boolean): void {
    this.#spin(
      working
        ? { label: "working — Ctrl-C to interrupt", paint: color.tool }
        : null,
    );
  }

  /** The model is writing the handover note that replaces the conversation. */
  setCompacting(compacting: boolean): void {
    this.#spin(
      compacting
        ? { label: "compacting — writing a summary of this conversation", paint: color.compact }
        : null,
    );
  }


  /**
   * A row of discrete stops with the current one marked.
   *
   * Three settings do not need a list and a scrollbar. Drawn as a track so the
   * ordering is visible — these are steps along one axis, not unrelated
   * options — and it lives in the status row, which is already the place the
   * screen uses to say what it is waiting for.
   */
  openSlider(label: string, stops: readonly string[], current: string): void {
    const at = Math.max(0, stops.indexOf(current));
    this.#slider = Object.freeze({ label, stops: Object.freeze([...stops]), at });
    this.#drawSlider();
  }

  closeSlider(): void {
    this.#slider = null;
    this.#status.setText("");
    this.#tui.requestRender();
  }

  /**
   * A vertical list to walk with the arrows.
   *
   * It lives in the status row, one row per entry, so it appears above the
   * editor and takes nothing from the transcript. Whatever was being typed
   * stays where it was: the picker owns the arrows and Enter only while it is
   * up.
   */
  openPicker(label: string, rows: readonly string[], at = 0): void {
    this.#picker = Object.freeze({
      label,
      rows: Object.freeze([...rows]),
      at: Math.min(Math.max(0, at), Math.max(0, rows.length - 1)),
    });
    this.#drawPicker();
  }

  closePicker(): void {
    this.#picker = null;
    this.#status.setText("");
    this.#tui.requestRender();
  }

  #drawPicker(): void {
    const picker = this.#picker;
    if (picker === null) return;
    const drawn = picker.rows.map((row, index) =>
      index === picker.at
        ? `${color.tool("▸")} ${color.bold(row)}`
        : `  ${color.dim(row)}`,
    );
    this.#status.setText(
      [
        color.dim(picker.label),
        ...drawn,
        color.dim("↑/↓ choose · enter resume · esc cancel"),
      ].join("\n"),
    );
    this.#tui.requestRender();
  }

  #drawSlider(): void {
    const slider = this.#slider;
    if (slider === null) return;
    const gap = " ──── ";
    let track = "";
    const marks: number[] = [];
    for (const [index, stop] of slider.stops.entries()) {
      if (index > 0) track += gap;
      marks.push(track.length + Math.floor(Math.max(0, stop.length - 1) / 2));
      track += stop;
    }
    let knobs = "";
    for (const [index, column] of marks.entries()) {
      knobs = knobs.padEnd(column, " ") + (index === slider.at ? "▲" : "·");
    }
    const painted = slider.stops
      .map((stop, index) =>
        index === slider.at ? color.tool(color.bold(stop)) : color.dim(stop),
      )
      .reduce((line, stop, index) => (index === 0 ? stop : line + color.dim(gap) + stop), "");
    this.#status.setText(
      `${color.dim(`${slider.label}  `)}${painted}\n` +
        `${" ".repeat(slider.label.length + 2)}${color.tool(knobs)}   ` +
        color.dim("←/→ choose · enter apply · esc cancel"),
    );
    this.#tui.requestRender();
  }

  get editorText(): string {
    return this.#editor.getText();
  }

  clearEditor(): void {
    this.#editor.setText("");
  }

  rememberSubmission(text: string): void {
    this.#editor.addToHistory(text);
  }

  /**
   * Keys the loop owns rather than the editor.
   *
   * They are taken before the focused component sees them, so Ctrl-C reaches a
   * running turn while the editor holds focus. Everything else falls through.
   */
  /**
   * Ask tmux whether its mouse option is on, and turn it on when it is not.
   *
   * The wheel and click-drag only work in tmux when mouse mode is on, so
   * enabling it for this window (not globally) is the difference between the
   * feature working out of the box and asking the operator to edit their
   * tmux.conf. set-clipboard is enabled for this session so OSC 52 copies
   * reach the outer terminal. Both checks run once at startup and never
   * block the screen.
   */
  #probeTmuxMouse(): void {
    try {
      spawn("tmux", ["set", "-w", "mouse", "on"], {
        stdio: "ignore",
      }).once("error", () => {
        this.#tmuxWheelHint = true;
        this.#maybeShowTmuxHint();
      });
      spawn("tmux", ["set", "-s", "set-clipboard", "on"], {
        stdio: "ignore",
      });
      this.#tmuxWheelHint = false;
      return;
    } catch {
      this.#tmuxWheelHint = true;
      this.#maybeShowTmuxHint();
    }
  }

  /** Show the tmux hint once, briefly, if the probe answered "off". */
  #maybeShowTmuxHint(): void {
    if (!this.#tmuxWheelHint || !this.#attached) return;
    this.note("tmux: wheel scrolling and mouse selection need mouse mode; run tmux set -g mouse on");
    const timer = setTimeout(() => {
      this.note("");
    }, 8000);
    timer.unref();
  }

  /** Start or keep the selection auto-scroll timer for an edge drag. */
  #updateSelectionAutoScroll(direction: 1 | -1, col: number): void {
    if (
      direction === this.#selectionAutoScrollDirection &&
      this.#selectionAutoScrollTimer !== null
    ) {
      this.#selectionAutoScrollCol = col;
      return;
    }
    this.#stopSelectionAutoScroll();
    this.#selectionAutoScrollDirection = direction;
    this.#selectionAutoScrollCol = col;
    this.#selectionAutoScrollTimer = setTimeout(
      () => this.#selectionAutoScrollTick(),
      SELECTION_AUTO_SCROLL_DELAY_MS,
    );
  }

  /** One auto-scroll step, rescheduled while the drag stays on the edge. */
  #selectionAutoScrollTick(): void {
    this.#selectionAutoScrollTimer = null;
    const direction = this.#selectionAutoScrollDirection;
    if (direction === null) return;
    const scrolled = this.#tui.scrollSelection(
      direction,
      this.#selectionAutoScrollCol,
    );
    if (!scrolled) {
      const edgeRow = direction === 1 ? 0 : this.#tui.terminal.rows - 1;
      this.#tui.extendSelection(edgeRow, this.#selectionAutoScrollCol);
      this.#stopSelectionAutoScroll();
      return;
    }
    this.#selectionAutoScrollTimer = setTimeout(
      () => this.#selectionAutoScrollTick(),
      SELECTION_AUTO_SCROLL_INTERVAL_MS,
    );
  }

  #stopSelectionAutoScroll(): void {
    if (this.#selectionAutoScrollTimer !== null) {
      clearTimeout(this.#selectionAutoScrollTimer);
      this.#selectionAutoScrollTimer = null;
    }
    this.#selectionAutoScrollDirection = null;
  }

  /** Copy text to the system clipboard via the OSC 52 escape sequence. */
  #copySelection(text: string): void {
    const base64 = Buffer.from(text, "utf8").toString("base64");
    this.#tui.terminal.write(`\x1b]52;c;${base64}\x07`);
  }

  attach(handlers: ScreenHandlers): void {
    // In tmux the wheel and click-drag belong to tmux, and only work with
    // its mouse option on. Say so once, briefly, at startup.
    this.#attached = true;
    this.#maybeShowTmuxHint();
    this.#editor.onSubmit = (text) => {
      handlers.onSubmit(text);
    };
    const listener = (data: string): TuiInputListenerResult => {
      // The negotiated Kitty flags include event types, so letting go of a key
      // is reported as well as pressing it, and `matchesKey` is as happy to
      // match the release. The TUI drops releases before the focused component
      // sees them, but an input listener runs ahead of that filter. Left to
      // pass through, one press of an arrow moved the slider two stops and one
      // Ctrl-D would have asked to exit twice.
      if (isKeyRelease(data)) return { consume: this.#slider !== null };
      // While the picker is up it owns the arrows and Enter, the same way the
      // slider does, so the line being typed survives either of them.
      if (this.#picker !== null) {
        const picker = this.#picker;
        const up = matchesKey(data, "up");
        if (up || matchesKey(data, "down")) {
          const at = Math.min(
            picker.rows.length - 1,
            Math.max(0, picker.at + (up ? -1 : 1)),
          );
          this.#picker = Object.freeze({ ...picker, at });
          this.#drawPicker();
          return { consume: true };
        }
        if (isEnter(data)) {
          const at = picker.at;
          this.closePicker();
          handlers.onChoose?.(at);
          return { consume: true };
        }
        if (isEscape(data) || isCtrlC(data)) {
          this.closePicker();
          handlers.onChoose?.(null);
          return { consume: true };
        }
        return { consume: true };
      }
      // While the slider is up it owns the arrows and Enter; nothing reaches
      // the editor, so the line being typed is still there afterwards.
      if (this.#slider !== null) {
        const slider = this.#slider;
        // Ask the key parser rather than comparing bytes. The TUI negotiates
        // the Kitty keyboard protocol when the terminal offers it, and then an
        // arrow is not `ESC [ C` at all — matching raw sequences left the
        // slider swallowing every key and looking frozen.
        const left = matchesKey(data, "left");
        if (left || matchesKey(data, "right")) {
          const step = left ? -1 : 1;
          const at = Math.min(slider.stops.length - 1, Math.max(0, slider.at + step));
          this.#slider = Object.freeze({ ...slider, at });
          this.#drawSlider();
          return { consume: true };
        }
        if (isEnter(data)) {
          const picked = slider.stops[slider.at] ?? null;
          this.closeSlider();
          handlers.onPick?.(picked);
          return { consume: true };
        }
        if (isEscape(data) || isCtrlC(data)) {
          this.closeSlider();
          handlers.onPick?.(null);
          return { consume: true };
        }
        return { consume: true };
      }
      // Wheel turns scroll the transcript history when the terminal delivers
      // them as SGR mouse sequences. Inside tmux mouse tracking (1002+1006)
      // is enabled at startup so the wheel reaches this handler; outside
      // tmux terminals keep the wheel for their own scrollback, which is
      // fine because FlashCoder renders into the main screen. Clicks are
      // consumed as well: there is no click action, and letting them through
      // would type garbage into the editor.
      const mouse = parseSgrMouseEvent(data);
      if (mouse !== null) {
        if (isWheelUp(mouse)) {
          this.#tui.scrollBy(WHEEL_SCROLL_LINES);
        } else if (isWheelDown(mouse)) {
          this.#tui.scrollBy(-WHEEL_SCROLL_LINES);
        } else if (mouse.button === 0) {
          // Left button: click-drag selects text inside the rendered window.
          // The selection is highlighted live and copied to the system
          // clipboard (OSC 52) on release, which tmux forwards when its
          // set-clipboard option is on. Dragging past the top or bottom edge
          // auto-scrolls the viewport so a selection can span more than one
          // screen of history.
          if (mouse.press && !mouse.motion) {
            this.#tui.beginSelection(mouse.y - 1, mouse.x - 1);
          } else if (mouse.press && mouse.motion) {
            const row = mouse.y - 1;
            const direction = this.#tui.selectionAutoScrollDirection(row);
            if (direction !== null) {
              // Keep a timer running while the drag rests on the edge, so
              // auto-scroll continues even when the mouse stops moving.
              this.#updateSelectionAutoScroll(direction, mouse.x - 1);
            } else {
              this.#stopSelectionAutoScroll();
              this.#tui.extendSelection(row, mouse.x - 1);
            }
          } else if (!mouse.press) {
            this.#stopSelectionAutoScroll();
            const selected = this.#tui.endSelection();
            if (selected !== null) this.#copySelection(selected);
          }
        }
        return { consume: true };
      }
      // PageUp/PageDown move one viewport, Home/End jump to the edges.
      // Scrolling up leaves the newest content; anything that types or runs
      // (handled below) drops the reader back to it first.
      if (matchesKey(data, "pageUp")) {
        this.#tui.scrollBy(Math.max(1, this.#tui.terminal.rows - 2));
        return { consume: true };
      }
      if (matchesKey(data, "pageDown")) {
        this.#tui.scrollBy(-Math.max(1, this.#tui.terminal.rows - 2));
        return { consume: true };
      }
      if (matchesKey(data, "home")) {
        this.#tui.scrollToTop();
        return { consume: true };
      }
      if (matchesKey(data, "end")) {
        this.#tui.scrollToBottom();
        return { consume: true };
      }
      if (this.#tui.isScrolled()) this.#tui.scrollToBottom();
      // Under the Kitty protocol Ctrl-C and Ctrl-D are `ESC [ 99 ; 5 u` and
      // `ESC [ 100 ; 5 u`, not the control bytes, so comparing bytes meant
      // neither interrupt nor exit reached this listener at all.
      if (isCtrlC(data)) {
        handlers.onInterrupt();
        return { consume: true };
      }
      if (
        (matchesKey(data, "ctrl+d") || data === CTRL_D) &&
        this.#editor.getText().length === 0
      ) {
        handlers.onExit();
        return { consume: true };
      }
      // A finished command should run, not complete to itself. The completion
      // list is still open on the exact match the user just typed, and Enter
      // belongs to it first, so `/compact` + Enter silently did nothing until a
      // second Enter arrived.
      if (
        isEnter(data) &&
        this.#editor.isShowingAutocomplete() &&
        this.#commandNames.has(this.#editor.getText().trim())
      ) {
        handlers.onSubmit(this.#editor.getText().trim());
        return { consume: true };
      }
      // Escape stops a turn, but only when the editor is not using it to close
      // its own completion list.
      if (
        isEscape(data) &&
        this.#activity !== null &&
        !this.#editor.isShowingAutocomplete()
      ) {
        handlers.onInterrupt();
        return { consume: true };
      }
      return undefined;
    };
    this.#detachInput = this.#tui.addInputListener(listener);
  }

  start(): void {
    this.#tui.start();
  }

  stop(): void {
    this.setWorking(false);
    this.#detachInput?.();
    this.#detachInput = null;
    this.#tui.stop();
  }

  /**
   * Give the terminal back to a nested prompt and take it again afterwards.
   *
   * The redraw is forced: whatever the nested prompt wrote is in no component,
   * so the differential state no longer describes the screen.
   */
  async suspended(action: () => Promise<void>): Promise<void> {
    // A plain stop leaves the cursor on a fresh line below the last rendered
    // row, so the nested prompt does not start glued to the editor's border.
    this.#tui.stop();
    try {
      await action();
    } finally {
      this.#tui.start();
      this.#tui.requestRender(true);
    }
  }

  /** Draw immediately rather than on the next frame. Used by tests. */
  renderNow(): void {
    this.#tui.renderNow();
  }
}
