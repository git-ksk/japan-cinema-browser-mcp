import { BrowserRuntimeError, CinemaBrowserRuntime } from "../../browser/runtime.js";
import { TohoReadAdapter } from "./adapter.js";

const TOHO_THEATER_LIST_URL = "https://www.tohotheater.jp/theater/find.html";
const MIN_THEATER_SCHEDULE_LINKS = 20;

interface TheaterRegionExpansionState {
  regionCount?: unknown;
  visibleScheduleLinks?: unknown;
  clicked?: unknown;
}

const EXPAND_THEATER_REGIONS_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const rendered = (el) => {
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const schedulePath = /^\\/net\\/schedule\\/\\d{3}\\/TNPI2000J01\\.do$/;
  const regionHeading = /^(?:北海道|東北|関東|中部|関西|中国|四国|九州)地区(?:\\s|$)/;
  const headings = Array.from(document.querySelectorAll('h3.theater-list-title.js-toggle-button'))
    .filter((el) => rendered(el) && regionHeading.test(normalize(el.textContent)));
  const regions = headings.map((heading) => {
    const panel = heading.nextElementSibling;
    const validPanel = panel && panel.matches('.theater-list-toggle-panel.js-toggle-panel') ? panel : null;
    return { heading, panel: validPanel };
  });
  const scheduleLinksInOpenPanels = () => {
    let count = 0;
    for (const { panel } of regions) {
      if (!panel || !rendered(panel)) continue;
      for (const anchor of Array.from(panel.querySelectorAll('a[href]'))) {
        try {
          const url = new URL(anchor.href, location.href);
          if (schedulePath.test(url.pathname)) count += 1;
        } catch {
          // Ignore malformed hrefs; the strict adapter validates accepted routes later.
        }
      }
    }
    return count;
  };
  const clicked = [];
  if (scheduleLinksInOpenPanels() < ${MIN_THEATER_SCHEDULE_LINKS}) {
    for (const { heading, panel } of regions) {
      if (!panel || rendered(panel)) continue;
      heading.click();
      clicked.push(normalize(heading.textContent).slice(0, 80));
    }
  }
  return {
    regionCount: regions.filter(({ panel }) => Boolean(panel)).length,
    visibleScheduleLinks: scheduleLinksInOpenPanels(),
    clicked
  };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expansionCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Current TOHO public theater UI keeps regional theater lists collapsed by default.
 * This adapter opens only rendered reviewed region toggles whose adjacent public
 * theater panel is closed, then delegates parsing and identity checks unchanged.
 */
export class TohoPublicUiReadAdapter extends TohoReadAdapter {
  constructor(private readonly uiRuntime: CinemaBrowserRuntime) {
    super(uiRuntime);
  }

  override async listTheaters(query?: string) {
    await this.ensureTheaterRegionsExpanded();
    return super.listTheaters(query);
  }

  private async ensureTheaterRegionsExpanded(): Promise<void> {
    const status = await this.uiRuntime.status();
    const currentUrl = typeof status.url === "string" ? status.url : "";
    if (!currentUrl.startsWith(TOHO_THEATER_LIST_URL)) {
      await this.uiRuntime.navigate(TOHO_THEATER_LIST_URL, "toho");
    }

    let regionCount = 0;
    let visibleScheduleLinks = 0;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const semantic = await this.uiRuntime.evaluateSemanticState<TheaterRegionExpansionState>(
        "toho",
        EXPAND_THEATER_REGIONS_EXPRESSION
      );
      regionCount = expansionCount(semantic.value.regionCount);
      visibleScheduleLinks = expansionCount(semantic.value.visibleScheduleLinks);
      if (visibleScheduleLinks >= MIN_THEATER_SCHEDULE_LINKS) return;
      await sleep(180);
    }

    throw new BrowserRuntimeError(
      "UI_STATE_CHANGED",
      "TOHO regional theater controls did not expose enough reviewed public schedule links within the bounded wait.",
      { regionCount, visibleScheduleLinks }
    );
  }
}
