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
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const schedulePath = /^\\/net\\/schedule\\/\\d{3}\\/TNPI2000J01\\.do$/;
  const regionHeading = /^(?:北海道|東北|関東|中部|関西|中国|四国|九州)地区(?:\\s|$)/;
  const sections = Array.from(document.querySelectorAll('.theater-list-section'));
  const regions = [];
  for (const section of sections) {
    const heading = Array.from(section.querySelectorAll('h2,h3,h4,h5,h6'))
      .find((el) => visible(el) && regionHeading.test(normalize(el.textContent)));
    if (!heading) continue;
    regions.push({ section, heading });
  }
  const visibleScheduleLinks = () => Array.from(document.querySelectorAll('a[href]')).filter((anchor) => {
    if (!visible(anchor)) return false;
    try {
      const url = new URL(anchor.href, location.href);
      return schedulePath.test(url.pathname);
    } catch {
      return false;
    }
  }).length;
  const clicked = [];
  if (visibleScheduleLinks() < ${MIN_THEATER_SCHEDULE_LINKS}) {
    for (const { section, heading } of regions) {
      const alreadyOpen = Array.from(section.querySelectorAll('a[href]')).some((anchor) => {
        if (!visible(anchor)) return false;
        try {
          return schedulePath.test(new URL(anchor.href, location.href).pathname);
        } catch {
          return false;
        }
      });
      if (alreadyOpen) continue;
      heading.click();
      clicked.push(normalize(heading.textContent).slice(0, 80));
    }
  }
  return {
    regionCount: regions.length,
    visibleScheduleLinks: visibleScheduleLinks(),
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
 * This adapter only opens the visible reviewed region headings, then delegates all
 * theater/schedule parsing and identity checks to the existing fail-closed adapter.
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
