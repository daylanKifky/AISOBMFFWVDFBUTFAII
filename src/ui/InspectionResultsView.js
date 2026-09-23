import ByteViewIndex from "../inspection/byte-view/ByteViewIndex.js";
import deriveMediaInfo from "../post-process/index.js";
import { getActualBoxSize } from "../utils/box_size.js";
import { getByteViewBoxKey } from "../utils/byte_view.js";
import { fmtBytes } from "../utils/bytes.js";
import { requireElementById } from "../utils/dom.js";
import {
  BoxTreeNodeView,
  ByteViewTab,
  renderCodecDetails,
  renderMediaInfo,
  renderSampleView,
  renderSizeChart,
  renderTreePositionMap,
  switchToTab,
} from "./tabs/index.js";

/**
 * Handle the central UI around result presentation, both wile parsing (where
 * the progressive box tree is shown) and at its end (where all UI formatting)
 * the result is shown.
 *
 * @typedef {{ severity: "warning" | "error", message: string }} ParseNotice
 * @typedef {import("../utils/box_size.js").BoxWithOptionalActualSize} PendingParsedBox
 */

class InspectionResultsViewClass {
  #tabs = requireElementById("tabs", HTMLElement);
  #results = requireElementById("results", HTMLElement);
  #resultNotices = requireElementById("result-notices", HTMLElement);
  #boxesPanel = requireElementById("tab-boxes", HTMLElement);
  #inspectionSummary = requireElementById("inspection-summary", HTMLElement);
  #inspectionSummaryFacts = requireElementById(
    "inspection-summary-facts",
    HTMLElement,
  );
  #collapseAllBoxes = requireElementById(
    "collapse-all-boxes",
    HTMLButtonElement,
  );
  #infoPanel = requireElementById("tab-info", HTMLElement);
  #wrapper = requireElementById("file-description", HTMLElement);
  #byteTabButton = requireElementById("tab-button-bytes", HTMLButtonElement);
  #bytePanel = requireElementById("tab-bytes", HTMLElement);
  #byteView = requireElementById("byte-view", HTMLElement);
  #mediaInfo = requireElementById("media-info", HTMLElement);
  #codecTabButton = requireElementById(
    "tab-button-codec-details",
    HTMLButtonElement,
  );
  #codecPanel = requireElementById("tab-codec-details", HTMLElement);
  #codecDetails = requireElementById("codec-details", HTMLElement);
  #sizesPanel = requireElementById("tab-sizes", HTMLElement);
  #sizeChart = requireElementById("size-chart", HTMLElement);
  #sampleTabButton = requireElementById(
    "tab-button-samples",
    HTMLButtonElement,
  );
  #sampleTabPanel = requireElementById("tab-samples", HTMLElement);
  #sampleView = requireElementById("sample-view", HTMLElement);
  /** @type {Array<import("./tabs/index.js").BoxTreeNodeView>} */
  #stack = [];
  /** @type {Array<import("isobmff-inspector").ParsedBox>} */
  #completedTopLevelBoxes = [];
  #errorBoxIndex = -1;
  #abortCtrlr = new AbortController();

  constructor() {
    this.#collapseAllBoxes.addEventListener("click", () => {
      const boxes = this.#wrapper.getElementsByClassName("box-node");
      for (let index = 0; index < boxes.length; index++) {
        const box = boxes[index];
        if (box instanceof HTMLDetailsElement) {
          box.open = false;
        }
      }
    });
  }

  /**
   * @param {boolean} isLoading
   */
  setLoading(isLoading) {
    this.#results.classList.toggle("is-stale-loading", isLoading);
    this.#results.inert = isLoading;
    this.#results.setAttribute("aria-busy", isLoading ? "true" : "false");
  }

  /**
   * TODO: seems awkward here
   */
  finishRequest() {
    this.#results.setAttribute("aria-busy", "false");
  }

  /**
   * Keep parsed boxes available after a user cancels an active stream.
   */
  finishPartialRender() {
    this.#results.setAttribute("aria-busy", "false");
    this.#tabs.classList.remove("is-reserved");
    this.#tabs.classList.add("is-visible");
  }

  /**
   * Clear the whole inspection UI.
   */
  clear() {
    this.#abortCtrlr.abort();
    this.#abortCtrlr = new AbortController();
    this.#clearDom();
    this.#stack.length = 0;
    this.#completedTopLevelBoxes.length = 0;
    this.#errorBoxIndex = -1;
  }

  /**
   * Setup the base UI for a new parsed file.
   */
  initializeForNewRender() {
    this.clear();
    this.#results.inert = false;
    this.#results.setAttribute("aria-busy", "true");
    this.#setByteViewAvailability(false, null);
    this.#tabs.hidden = false;
    switchToTab("boxes");
    this.#tabs.classList.add("is-reserved");
    this.#tabs.classList.remove("is-visible");
  }

  /**
   * Begin rendering the box that has just been encounted while parsing
   * in the "box tree" that should be currently in view.
   * @param {PendingParsedBox} box
   * @param {number} depth
   * @param {string[]} path
   */
  renderBoxTreeStart(box, depth, path) {
    this.#stack.length = depth;
    const view =
      depth === 0
        ? new BoxTreeNodeView(box, {
            autoOpen: false,
            shallow: true,
          })
        : this.#stack[depth - 1]?.appendChildBox(box, {
            autoOpen: false,
          });
    if (!view) {
      throw new Error(`missing parent for ${path.join("/")}`);
    }
    if (depth === 0) {
      this.#wrapper.appendChild(view.element);
    }
    this.#stack[depth] = view;
  }

  /**
   * Once a box has been completely parsed, updated with potential new
   * information since `renderBoxTreeStart` was called.
   * This function returns `true` if it could complete the box. See return
   * value documentation for the semantics of a `false` return value.
   *
   * @param {import("isobmff-inspector").ParsedBox} box - The full box
   * metadata to add to the tree.
   * @param {number} depth - The "depth" of the box, `0` being top-level. used
   * for defensive reasons.
   * @returns {boolean} - Returns `false` either if this box was never
   * signaled through `renderBoxTreeStart`, or if it wasn't the last one
   * encountered at that depth.
   * In both of those cases, nothing new has been rendered.
   * Returns `true` if it was the last "started" box at that depth and
   * render the supplementary information.
   */
  completeStartedBox(box, depth) {
    const current = this.#stack[depth];
    if (!current) {
      return false;
    }

    current.updateBox(box);
    if (depth === 0) {
      this.#completedTopLevelBoxes.push(box);
      this.#renderInspectionSummary();
    }
    return true;
  }

  /**
   * @param {import("isobmff-inspector").ParsedBox} box
   */
  appendStandaloneTopLevelBox(box) {
    const view = new BoxTreeNodeView(box, {
      autoOpen: false,
    });
    this.#wrapper.appendChild(view.element);
    this.#completedTopLevelBoxes.push(box);
    this.#renderInspectionSummary();
  }

  /**
   * Add the given "notice" (e.g. warning / error proeminently featured on
   * screen) to the UI.
   * @param {ParseNotice} notice
   */
  renderNotice(notice) {
    const noticeEl = document.createElement("div");
    noticeEl.className = `parse-notice issue-list${
      notice.severity === "warning" ? " warn" : ""
    }`;
    const item = document.createElement("div");
    item.className = "issue-item";
    item.textContent = notice.message;
    noticeEl.appendChild(item);
    this.#resultNotices.appendChild(noticeEl);
  }

  /**
   * To call once parsing is finished, to start rendering the full analysis
   * UI on that file.
   * @param {{
   *   topLevelBoxes: Array<import("isobmff-inspector").ParsedBox>,
   *   supplementalMetadata?: {
   *     boxes: Array<import("isobmff-inspector").ParsedBox>,
   *   } | null,
   *   codecDetailsResults?: Array<any> | null,
   *   byteViewData?: import("../inspection/byte-view/ByteViewCollector.js").ByteViewRenderData | null,
   *   projections?: import("../post-process/projections.js").InspectionProjections | null,
   * } | null} [options]
   */
  renderFullResults(options = null) {
    const topLevelBoxes = options?.topLevelBoxes ?? [];
    const supplementalMetadata = options?.supplementalMetadata ?? null;
    const renderOptions = supplementalMetadata
      ? { supplementalBoxes: supplementalMetadata.boxes }
      : {};
    const projections = options?.projections ?? null;
    this.#renderInspectionSummary(
      projections?.mediaInfo ?? null,
      options?.codecDetailsResults ?? null,
    );
    renderMediaInfo(topLevelBoxes, {
      ...renderOptions,
      mediaInfo: projections?.mediaInfo,
    });
    const hasCodecDetails = renderCodecDetails(topLevelBoxes, {
      ...renderOptions,
      results: options?.codecDetailsResults ?? null,
    });
    this.#codecTabButton.hidden = !hasCodecDetails;
    this.#codecPanel.hidden = !hasCodecDetails;
    const hasSampleView = renderSampleView(topLevelBoxes, {
      ...renderOptions,
      mediaInfo: projections?.mediaInfo,
    });
    this.#sampleTabButton.hidden = !hasSampleView;
    this.#sampleTabPanel.hidden = !hasSampleView;
    renderSizeChart(topLevelBoxes);
    renderTreePositionMap(
      topLevelBoxes,
      this.#wrapper,
      this.#abortCtrlr.signal,
    );
    const byteViewData = options?.byteViewData ?? null;
    ByteViewTab.render(byteViewData, {
      treeRoot: this.#wrapper,
      abortSignal: this.#abortCtrlr.signal,
    });
    this.#setByteViewAvailability(byteViewData !== null, byteViewData);
    this.#tabs.classList.remove("is-reserved");
    this.#tabs.classList.add("is-visible");
  }

  /**
   * To call if parsing failed, this will update the UI accordingly.
   */
  finalizeFailedRender() {
    this.#tabs.hidden = true;
    this.#tabs.classList.remove("is-reserved", "is-visible");
    this.#setByteViewAvailability(false, null);
    this.#abortCtrlr.abort();
  }

  #clearDom() {
    this.#resultNotices.replaceChildren();
    this.#inspectionSummary.hidden = true;
    this.#inspectionSummaryFacts.replaceChildren();
    this.#restorePanelRoot(this.#boxesPanel, this.#wrapper);
    this.#restorePanelRoot(this.#bytePanel, this.#byteView);
    this.#restorePanelRoot(this.#infoPanel, this.#mediaInfo);
    this.#restorePanelRoot(this.#codecPanel, this.#codecDetails);
    this.#restorePanelRoot(this.#sampleTabPanel, this.#sampleView);
    this.#restorePanelRoot(this.#sizesPanel, this.#sizeChart);
    ByteViewTab.reset();
    this.#byteTabButton.hidden = true;
    this.#bytePanel.hidden = true;
    this.#codecTabButton.hidden = true;
    this.#codecPanel.hidden = true;
    this.#sampleTabButton.hidden = true;
    this.#sampleTabPanel.hidden = true;
    this.#tabs.hidden = true;
    this.#tabs.classList.remove("is-reserved", "is-visible");
    this.#results.classList.remove("is-stale-loading");
    this.#results.inert = false;
    this.#results.setAttribute("aria-busy", "false");
    this.#setByteViewAvailability(false, null);
  }

  /**
   * @param {import("../post-process/index.js").MediaInfo | null} [mediaInfo]
   * @param {Array<any> | null} [codecDetailsResults]
   */
  #renderInspectionSummary(mediaInfo = null, codecDetailsResults = null) {
    const boxes = this.#completedTopLevelBoxes;
    if (
      !boxes.some((box) => box.type === "ftyp") ||
      !boxes.some((box) => box.type === "moov")
    ) {
      return;
    }
    const info = mediaInfo ?? deriveMediaInfo(boxes);
    const boxErrorMessages = getBoxErrorMessages(boxes);
    const boxErrorCount = countBoxErrors(boxes);
    const codecErrorCount = countCodecPayloadErrors(
      codecDetailsResults ?? [],
      boxErrorMessages,
    );
    const errorCount = boxErrorCount + codecErrorCount;
    const errorBoxKeys = getBoxErrorKeys(boxes);
    const rows = [
      createSummaryRow("format", info.isFragmented ? "fragmented MP4" : "MP4"),
      ...info.tracks.map((track, index) =>
        createSummaryRow(
          `track${String(index + 1).padStart(2, "0")}`,
          formatTrackSummary(track),
        ),
      ),
      createSummaryRow(
        "fragment size",
        info.isFragmented
          ? formatFragmentSizeStatistics(boxes)
          : "not fragmented",
      ),
      createSummaryRow("errors", String(errorCount), errorCount > 0),
    ];
    const errorRow = rows[rows.length - 1];
    if (errorBoxKeys.length) {
      const previous = createErrorNavigationButton("⏶", "Previous error");
      previous.addEventListener("click", () => {
        this.#focusErrorBox(errorBoxKeys, -1);
      });
      const next = createErrorNavigationButton("⏷", "Next error");
      next.addEventListener("click", () => {
        this.#focusErrorBox(errorBoxKeys, 1);
      });
      errorRow.appendChild(previous);
      errorRow.appendChild(next);
    }
    this.#inspectionSummaryFacts.replaceChildren(...rows);
    this.#inspectionSummary.hidden = false;
  }

  /**
   * @param {string[]} errorBoxKeys
   * @param {-1 | 1} direction
   */
  #focusErrorBox(errorBoxKeys, direction) {
    this.#errorBoxIndex =
      (this.#errorBoxIndex + direction + errorBoxKeys.length) %
      errorBoxKeys.length;
    const targetKey = errorBoxKeys[this.#errorBoxIndex];
    const nodes = this.#wrapper.getElementsByClassName("box-node");
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (!(node instanceof HTMLElement) || node.dataset.boxKey !== targetKey) {
        continue;
      }
      openAncestorBoxes(node, this.#wrapper);
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      if (node.firstElementChild instanceof HTMLElement) {
        node.firstElementChild.focus();
      }
      return;
    }
  }

  /**
   * @param {boolean} isAvailable
   * @param {import("../inspection/byte-view/ByteViewCollector.js").ByteViewRenderData | null} byteViewData
   */
  #setByteViewAvailability(isAvailable, byteViewData) {
    this.#results.dataset.byteViewReady = isAvailable ? "true" : "false";
    const byteIndex = new ByteViewIndex(byteViewData);
    const buttons = this.#results.getElementsByClassName(
      "byte-view-jump-button",
    );
    for (let index = 0; index < buttons.length; index++) {
      const button = buttons[index];
      if (button instanceof HTMLButtonElement) {
        if (!isAvailable || !byteViewData) {
          button.disabled = true;
          button.title = "Byte View is not available for this inspection";
          continue;
        }
        const fieldId = button.dataset.byteFieldId ?? "";
        const field = byteIndex.getFieldById(fieldId);
        const isCaptured =
          !!field &&
          byteIndex.doesRangeOverlapCapturedBytes(
            field.offset,
            field.endExclusive,
          );
        button.disabled = !isCaptured;
        if (!field || !isCaptured) {
          button.title =
            "Byte View did not retain this field because it is outside the capture limit";
          continue;
        }
        button.title = byteIndex.isRangeFullyCaptured(
          field.offset,
          field.endExclusive,
        )
          ? "Show this field in Byte View"
          : "Show retained bytes for this field in Byte View";
      }
    }
  }

  /**
   * @param {HTMLElement} panel
   * @param {HTMLElement} root
   */
  #restorePanelRoot(panel, root) {
    if (panel === this.#boxesPanel) {
      if (this.#inspectionSummary.parentElement !== panel) {
        panel.appendChild(this.#inspectionSummary);
      }
      if (root.parentElement !== panel) {
        panel.appendChild(root);
      }
      const children = panel.children;
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child !== this.#inspectionSummary && child !== root) {
          panel.removeChild(child);
        }
      }
      root.replaceChildren();
      panel.hidden = false;
      panel.classList.add("active");
      return;
    }
    if (root.parentElement !== panel) {
      panel.replaceChildren(root);
    } else {
      const siblings = panel.children;
      while (siblings.length > 1) {
        panel.removeChild(siblings[siblings.length - 1]);
      }
    }
    root.replaceChildren();
    panel.hidden = panel !== this.#boxesPanel;
    panel.classList.toggle("active", panel === this.#boxesPanel);
  }
}

/**
 * @param {Array<import("isobmff-inspector").ParsedBox>} boxes
 */
function countBoxErrors(boxes) {
  let count = 0;
  for (const box of boxes) {
    count += box.issues.filter((issue) => issue.severity === "error").length;
    count += countBoxErrors(box.children ?? []);
  }
  return count;
}

/**
 * @param {Array<import("isobmff-inspector").ParsedBox>} boxes
 */
function getBoxErrorMessages(boxes) {
  const messages = new Set();
  collectBoxErrorMessages(boxes, messages);
  return messages;
}

/**
 * @param {Array<import("isobmff-inspector").ParsedBox>} boxes
 * @param {Set<string>} messages
 */
function collectBoxErrorMessages(boxes, messages) {
  for (const box of boxes) {
    for (const issue of box.issues) {
      if (issue.severity === "error") {
        messages.add(issue.message);
      }
    }
    collectBoxErrorMessages(box.children ?? [], messages);
  }
}

/**
 * @param {Array<any>} results
 * @param {Set<string>} boxErrorMessages
 */
function countCodecPayloadErrors(results, boxErrorMessages) {
  let count = 0;
  for (const result of results) {
    for (const issue of result.issues ?? []) {
      if (
        issue.includes("SEI") &&
        issue.includes("truncated") &&
        !boxErrorMessages.has(issue)
      ) {
        count++;
      }
    }
  }
  return count;
}

/**
 * @param {import("../post-process/index.js").TrackInfo} track
 */
function formatTrackSummary(track) {
  const frameRate = track.timing?.match(/nominal ([^ ]+ fps)/)?.[1] ?? null;
  return [
    track.kind,
    track.codec,
    track.dimensions,
    frameRate,
    track.audio,
    track.language,
  ]
    .filter((value) => value !== null && value !== "")
    .join(" · ");
}

/**
 * @param {string} label
 * @param {string} value
 * @param {boolean} [isError]
 */
function createSummaryRow(label, value, isError = false) {
  const row = document.createElement("div");
  row.className = `inspection-summary-row${isError ? " is-error" : ""}`;
  const labelElement = document.createElement("span");
  labelElement.className = "inspection-summary-label";
  labelElement.textContent = label;
  const valueElement = document.createElement("span");
  valueElement.className = "inspection-summary-value";
  valueElement.textContent = value;
  row.appendChild(labelElement);
  row.appendChild(valueElement);
  return row;
}

/**
 * @param {string} text
 * @param {string} label
 */
function createErrorNavigationButton(text, label) {
  const button = document.createElement("button");
  button.className = "inspection-error-nav";
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

/**
 * @param {Array<import("isobmff-inspector").ParsedBox>} boxes
 * @returns {string[]}
 */
function getBoxErrorKeys(boxes) {
  const keys = [];
  for (const box of boxes) {
    if (box.issues.some((issue) => issue.severity === "error")) {
      const key = getByteViewBoxKey(box);
      if (key) {
        keys.push(key);
      }
    }
    keys.push(...getBoxErrorKeys(box.children ?? []));
  }
  return keys;
}

/**
 * @param {HTMLElement} node
 * @param {HTMLElement} root
 */
function openAncestorBoxes(node, root) {
  let parent = node.parentElement;
  while (parent && parent !== root) {
    if (parent instanceof HTMLDetailsElement) {
      parent.open = true;
    }
    parent = parent.parentElement;
  }
}

/**
 * @param {Array<import("isobmff-inspector").ParsedBox>} boxes
 */
function formatFragmentSizeStatistics(boxes) {
  const sizes = [];
  let currentSize = 0;
  let inFragment = false;
  for (const box of boxes) {
    if (box.type === "moof") {
      if (inFragment) {
        sizes.push(currentSize);
      }
      currentSize = 0;
      inFragment = true;
    }
    if (inFragment) {
      currentSize += getActualBoxSize(box);
    }
  }
  if (inFragment) {
    sizes.push(currentSize);
  }
  if (!sizes.length) {
    return "awaiting media fragment";
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return `mean ${fmtBytes(total / sizes.length)} · min ${fmtBytes(Math.min(...sizes))} · max ${fmtBytes(Math.max(...sizes))}`;
}

const InspectionResultsView = new InspectionResultsViewClass();

export default InspectionResultsView;
