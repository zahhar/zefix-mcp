#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const API_BASE = "https://www.zefix.ch/ZefixREST/api/v1/firm";
const USER_AGENT = "zefix-mcp-unofficial";
const REQUEST_TIMEOUT_MS = 5000;
const SEQUENTIAL_REQUEST_DELAY_MS = 250;

const server = new McpServer({
  name: "zefix-mcp-unofficial",
  version,
});

type JsonObject = Record<string, unknown>;

type HttpMethod = "GET" | "POST";

interface SearchResponse {
  list?: CompanySummary[];
  hasMoreResults?: boolean;
}

interface CompanySummary {
  name?: string;
  uid?: string;
  uidFormatted?: string;
  legalSeatId?: number;
  legalSeat?: string;
  status?: string;
  // The Zefix API is inconsistent: search results return `ehraid` (lowercase),
  // while detail endpoints return `ehraId` (camelCase). Both must be handled.
  ehraId?: string | number;
  ehraid?: string | number;
  cantonalExcerptWeb?: string;
}

interface CompanyAddress {
  organisation?: string;
  careOf?: string;
  street?: string;
  houseNumber?: string;
  addon?: string;
  poBox?: string;
  town?: string;
  swissZipCode?: string;
  country?: string;
  [key: string]: unknown;
}

interface CompanyOldName {
  name?: string;
}

interface CantonDictionaryEntry {
  id: number;
  canton: string;
}

interface LocationDictionaryEntry {
  id: number;
  bfsId?: number;
  canton: string;
  name: string;
  alternateNames?: string[] | null;
}

interface LegalFormDictionaryEntry {
  id: number;
  name?: Record<string, string>;
  kurzform?: Record<string, string>;
}

interface CompanyDetails extends CompanySummary {
  purpose?: string;
  address?: CompanyAddress | null;
  oldNames?: CompanyOldName[] | null;
  translation?: string[] | null;
  auditFirms?: CompanySummary[] | null;
  hasTakenOver?: CompanySummary[] | null;
  wasTakenOverBy?: CompanySummary[] | null;
}

interface ShabPubEntry {
  shabDate?: string;
  message?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DICT_DIR = join(__dirname, "..", "dict");

let cantonsDictionaryCache: CantonDictionaryEntry[] | null = null;
let locationsDictionaryCache: LocationDictionaryEntry[] | null = null;
let legalFormsDictionaryCache: LegalFormDictionaryEntry[] | null = null;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

async function loadCantonsDictionary(): Promise<CantonDictionaryEntry[]> {
  if (cantonsDictionaryCache) {
    return cantonsDictionaryCache;
  }

  const filePath = join(DICT_DIR, "cantons.json");
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as CantonDictionaryEntry[];
  cantonsDictionaryCache = parsed;
  return parsed;
}

async function loadLocationsDictionary(): Promise<LocationDictionaryEntry[]> {
  if (locationsDictionaryCache) {
    return locationsDictionaryCache;
  }

  const filePath = join(DICT_DIR, "locations.json");
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as LocationDictionaryEntry[];
  locationsDictionaryCache = parsed;
  return parsed;
}

async function loadLegalFormsDictionary(): Promise<LegalFormDictionaryEntry[]> {
  if (legalFormsDictionaryCache) {
    return legalFormsDictionaryCache;
  }

  const filePath = join(DICT_DIR, "legal_forms.json");
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as LegalFormDictionaryEntry[];
  legalFormsDictionaryCache = parsed;
  return parsed;
}

const dictionariesReady = Promise.all([
  loadCantonsDictionary(),
  loadLocationsDictionary(),
  loadLegalFormsDictionary(),
]);

function resolveCantonIds(
  requestedCantons: string[],
  dictionary: CantonDictionaryEntry[],
): { ids: number[]; skipped: string[] } {
  const ids = new Set<number>();
  const skipped: string[] = [];

  for (const requestedCanton of requestedCantons) {
    const trimmed = requestedCanton.trim();

    if (!/^[a-z]{2}$/i.test(trimmed)) {
      skipped.push(requestedCanton);
      continue;
    }

    const normalizedCanton = normalize(trimmed);
    const matches = dictionary.filter((entry) => normalize(entry.canton) === normalizedCanton);

    if (matches.length === 0) {
      skipped.push(requestedCanton);
      continue;
    }

    for (const match of matches) {
      ids.add(match.id);
    }
  }

  return {
    ids: [...ids],
    skipped,
  };
}

function resolveLocationIds(
  requestedLocations: string[],
  dictionary: LocationDictionaryEntry[],
): { ids: number[]; unresolved: string[] } {
  const ids = new Set<number>();
  const unresolved: string[] = [];

  for (const requestedLocation of requestedLocations) {
    const normalizedRequestedLocation = normalize(requestedLocation);
    const matches = dictionary.filter((entry) => {
      const primaryMatch = normalize(entry.name) === normalizedRequestedLocation;
      const alternateMatch = (entry.alternateNames ?? []).some(
        (alternateName) => normalize(alternateName) === normalizedRequestedLocation,
      );
      return primaryMatch || alternateMatch;
    });

    if (matches.length === 0) {
      unresolved.push(requestedLocation);
      continue;
    }

    for (const match of matches) {
      ids.add(match.id);
    }
  }

  return {
    ids: [...ids],
    unresolved,
  };
}

function resolveLegalFormIds(
  requestedLegalForms: string[],
  dictionary: LegalFormDictionaryEntry[],
): { ids: number[]; unresolved: string[] } {
  const ids = new Set<number>();
  const unresolved: string[] = [];

  for (const requestedLegalForm of requestedLegalForms) {
    const normalizedRequestedLegalForm = normalize(requestedLegalForm);

    const matches = dictionary.filter((entry) => {
      const nameValues = Object.values(entry.name ?? {}).map((value) => normalize(value));
      const shortFormValues = Object.values(entry.kurzform ?? {}).map((value) => normalize(value));
      return (
        nameValues.includes(normalizedRequestedLegalForm) ||
        shortFormValues.includes(normalizedRequestedLegalForm)
      );
    });

    if (matches.length === 0) {
      unresolved.push(requestedLegalForm);
      continue;
    }

    for (const match of matches) {
      ids.add(match.id);
    }
  }

  return {
    ids: [...ids],
    unresolved,
  };
}

async function makeZefixRequest<T>(
  url: string,
  payload: JsonObject | null = null,
  method: HttpMethod = "POST",
): Promise<{ data: T | null; error: string | null; status: number | null }> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  try {
    const response =
      method === "GET"
        ? await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        : await fetch(url, {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload ?? {}),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

    if (!response.ok) {
      // Return error details
      return {
        data: null,
        error: `HTTP error: ${response.status}`,
        status: response.status,
      };
    }

    const json = await response.json();
    return {
      data: json as T,
      error: null,
      status: response.status,
    };
  } catch (err: any) {
    // Handle timeout or network errors
    let errorMsg = "";
    if (err?.name === "AbortError") {
      errorMsg = "Timeout";
    } else {
      errorMsg = err?.message || "Unknown error";
    }
    return {
      data: null,
      error: errorMsg,
      status: null,
    };
  }
}

function lookupCanton(legalSeatId: number | undefined): string {
  if (legalSeatId === undefined || !locationsDictionaryCache) return "";
  return locationsDictionaryCache.find((e) => e.bfsId === legalSeatId)?.canton ?? "";
}

function formatCompanyShort(company: CompanySummary): string {
  const canton = lookupCanton(company.legalSeatId);
  const legalSeat = [company.legalSeat, canton].filter(Boolean).join(", ");
  const uid = company.uidFormatted ?? company.uid;
  return [
    company.name ? `Name: ${company.name}` : null,
    uid ? `UID: ${uid}` : null,
    legalSeat ? `Legal seat: ${legalSeat}` : null,
    company.status ? `Status: ${company.status}` : null,
    company.cantonalExcerptWeb ? `Registry: ${company.cantonalExcerptWeb}` : null,
  ].filter(Boolean).join("\n");
}

function formatRelatedCompany(c: CompanySummary): string {
  const canton = lookupCanton(c.legalSeatId);
  const legalSeat = [c.legalSeat, canton].filter(Boolean).join(", ");
  const parts = [c.name, legalSeat || undefined, c.uidFormatted ?? c.uid].filter(Boolean);
  return parts.join(", ");
}

function formatCompanyLong(company: CompanyDetails): string {
  const addressObj = company.address && typeof company.address === "object" ? company.address : {};

  const addressParts = Object.entries(addressObj)
    .filter(([key, value]) => key !== "country" && value !== null && value !== "")
    .map(([, value]) => String(value).trim());

  const canton = lookupCanton(company.legalSeatId);
  const legalSeat = [company.legalSeat, canton].filter(Boolean).join(", ");
  const uid = company.uidFormatted ?? company.uid;

  const oldNameValues = (company.oldNames ?? [])
    .map((item) => item.name?.trim())
    .filter((name): name is string => Boolean(name));

  const translation = company.translation?.length ? company.translation.join(", ") : null;

  const toBulletList = (label: string, items: CompanySummary[] | null | undefined): string | null =>
    items?.length
      ? `${label}:\n${items.map((c) => `- ${formatRelatedCompany(c)}`).join("\n")}`
      : null;

  const auditFirms = toBulletList("Auditor", company.auditFirms);
  const hasTakenOver = toBulletList("Has taken over", company.hasTakenOver);
  const wasTakenOverBy = toBulletList("Was taken over by", company.wasTakenOverBy);

  return [
    company.name ? `Name: ${company.name}` : null,
    uid ? `UID: ${uid}` : null,
    company.status ? `Status: ${company.status}` : null,
    legalSeat ? `Legal seat: ${legalSeat}` : null,
    addressParts.length > 0 ? `Official address: ${addressParts.join(", ")}` : null,
    company.purpose ? `Purpose: ${company.purpose}` : null,
    translation ? `Also known as: ${translation}` : null,
    oldNameValues.length > 0 ? `Old names: ${oldNameValues.join(", ")}` : null,
    auditFirms,
    hasTakenOver,
    wasTakenOverBy,
    company.cantonalExcerptWeb ? `Registry page: ${company.cantonalExcerptWeb}` : null,
  ].filter(Boolean).join("\n");
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function buildResponse(sections: string[], warnings: string[]) {
  const allSections =
    warnings.length > 0
      ? [...sections, `### WARNINGS\n${warnings.map((w) => `- ${w}`).join("\n")}`]
      : sections;
  return {
    content: [{ type: "text" as const, text: allSections.join("\n\n") }],
  };
}

server.registerTool(
  "get_companies",
  {
    title: "Search companies in Swiss Central Business Name Index (zefix.ch)",
    description: "Returns semi-structured markdown text including legal names, address, business identifiers, names of legal representatives, registered capital, mergers and acquisitions, auditor, purpose, former names, and the history of changes for the found company.",
    inputSchema: {
      name_or_uid: z.string().describe("Name (without legal form suffixes like 'AG' or 'GmbH') or UID of the company to search for. If UID is known ('CHE-nnn.nnn.nnn' or similar) – use it to get full details about the company."),
      language_key: z
        .string()
        .optional()
        .describe("Response language (allowed ISO-639-1 codes: en, de, fr, it)."),
      cantons: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          `Optional list of Swiss canton ISO-3166-2 codes:
ZH - Zurich
BE - Bern
LU - Lucerne
UR - Uri
SZ - Schwyz
OW - Obwalden
NW - Nidwalden
GL - Glarus
ZG - Zug
FR - Fribourg
SO - Solothurn
BS - Basel-Stadt
BL - Basel-Landschaft
SH - Schaffhausen
AR - Appenzell Ausserrhoden 
AI - Appenzell Innerrhoden
SG - St. Gallen
GR - Graubünden
AG - Aargau
TG - Thurgau
TI - Ticino
VD - Vaud
VS - Valais
NE - Neuchâtel
GE - Geneva
JU - Jura`,
        ),
      locations: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "Optional list of legal seat town or other locality names (case-insensitive).",
        ),
      legalForms: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "Optional list of legal forms, e.g., 'AG', 'GmbH', 'Sole proprietorship' (case-insensitive).",
        ),
      includeDeleted: z
        .boolean()
        .optional()
        .describe("When true, includes deleted/deregistered companies in the results. Default: false."),
      includeFormerNames: z
        .boolean()
        .optional()
        .describe("When true, also searches within former company names. Default: false."),
      exactSearch: z
        .boolean()
        .optional()
        .describe(
          "If True (default, preferred): searches from the start of the business name. Prefer using exact search for more accurate results. Fallback to 'False' if no results are found." +
          "If False: searches anywhere in the business name. Wildcard (*) supported for greater flexibility."
        ),
        phoneticSearch: z
        .boolean()
        .optional()
        .describe("Searches for similar sounding words. Enable it when audio input is used or when exact search did not find any result. Default: false.")
    },
  },
  async ({ name_or_uid, language_key, cantons, locations, legalForms, includeDeleted, includeFormerNames, phoneticSearch, exactSearch }) => {
    await dictionariesReady;

    const allowedLanguages = new Set(["en", "de", "fr", "it"]);
    const normalizedLanguage = (language_key ?? "en").toLowerCase();

    const warnings: string[] = [];

    if (!allowedLanguages.has(normalizedLanguage)) {
      return buildResponse(["Invalid language_key. Allowed ISO-639-1 codes are: en, de, fr, it."], warnings);
    }

    if (!name_or_uid.trim()) {
      return buildResponse(["Company name_or_uid must not be empty."], warnings);
    }

    let registryOffices: number[] | undefined;
    let legalSeats: number[] | undefined;
    let legalFormIds: number[] | undefined;

    if (cantons && cantons.length > 0) {
      const cantonDictionary = await loadCantonsDictionary();
      const cantonResolution = resolveCantonIds(cantons, cantonDictionary);

      if (cantonResolution.skipped.length > 0) {
        warnings.push(`Cantons not resolved and skipped: ${cantonResolution.skipped.join(", ")}`);
      }

      registryOffices = cantonResolution.ids;
    }

    if (locations && locations.length > 0) {
      const locationsDictionary = await loadLocationsDictionary();
      const locationsResolution = resolveLocationIds(locations, locationsDictionary);

      if (locationsResolution.unresolved.length > 0) {
        warnings.push(`Locations not found: ${locationsResolution.unresolved.join(", ")}`);
      }

      legalSeats = locationsResolution.ids;
    }

    if (legalForms && legalForms.length > 0) {
      const legalFormsDictionary = await loadLegalFormsDictionary();
      const legalFormsResolution = resolveLegalFormIds(legalForms, legalFormsDictionary);

      if (legalFormsResolution.unresolved.length > 0) {
        warnings.push(`Legal forms not found: ${legalFormsResolution.unresolved.join(", ")}`);
      }

      legalFormIds = legalFormsResolution.ids;
    }

    const url = `${API_BASE}/search.json`;
    const payload: JsonObject = {
      languageKey: normalizedLanguage,
      maxEntries: 100,
      offset: 0,
      name: name_or_uid,
    };

    if (exactSearch ?? true) {
      payload.searchType = "exact";
    }

    if (includeDeleted) {
      payload.deletedFirms = true;
    }

    if (includeFormerNames) {
      payload.formerNames = true;
    }

    if (phoneticSearch) {
      payload.phoneticSearchEnabled = true;
    }

    if (registryOffices && registryOffices.length > 0) {
      payload.registryOffices = registryOffices;
    }

    if (legalSeats && legalSeats.length > 0) {
      payload.legalSeats = legalSeats;
    }

    if (legalFormIds && legalFormIds.length > 0) {
      payload.legalForms = legalFormIds;
    }

    const hasFilters =
      (cantons?.length ?? 0) > 0 || (locations?.length ?? 0) > 0 || (legalForms?.length ?? 0) > 0;
    const noResultsMsg = hasFilters
      ? "No companies found for this combination of filters. Try relaxing your filter conditions (e.g., remove some cantons, locations, or legal forms) or try with another name/UID."
      : "No companies found for this name or UID.";

    const { data: searchData, error: searchError, status: searchStatus } = await makeZefixRequest<SearchResponse>(url, payload, "POST");

    if (searchError) {
      if (searchStatus === 404) {
        return buildResponse([noResultsMsg], warnings);
      }
      if (searchError === "Timeout") {
        return buildResponse([
          `Zefix API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. ` +
          `Try again later. If you are a developer, consider increasing REQUEST_TIMEOUT_MS (currently ${REQUEST_TIMEOUT_MS} ms).`
        ], warnings);
      }
      if (searchStatus === 401 || searchStatus === 403) {
        return buildResponse([
          `Access to Zefix API was denied (HTTP ${searchStatus}). The User-Agent may be blocked by Zefix. ` +
          `Try again later or contact Zefix. If you are a developer, try changing the USER_AGENT constant (currently "${USER_AGENT}").`
        ], warnings);
      }
      if (searchStatus === 429) {
        return buildResponse([
          `Zefix API rate limit exceeded (HTTP 429). Try again after waiting some time. ` +
          `If you are a developer, consider increasing SEQUENTIAL_REQUEST_DELAY_MS (currently ${SEQUENTIAL_REQUEST_DELAY_MS} ms).`
        ], warnings);
      }
      if (searchStatus !== null && searchStatus >= 500) {
        return buildResponse([
          `Zefix API is experiencing an internal error (HTTP ${searchStatus}). Try again later or contact Zefix.`
        ], warnings);
      }
      return buildResponse([`Zefix API error: ${searchError}`], warnings);
    }

    if (!searchData || !Array.isArray(searchData.list)) {
      return buildResponse(["Unexpected response from zefix.ch. The API may have changed or returned an unsupported format."], warnings);
    }

    const companies = searchData.list;
    const hasMoreResults = searchData.hasMoreResults ?? false;
    if (companies.length === 0) {
      return buildResponse([noResultsMsg], warnings);
    }

    if (companies.length === 1) {
      const company = companies[0];
      // Fallback to `ehraid` (lowercase) because the search endpoint returns it
      // lowercase while detail endpoints use camelCase `ehraId`. Both must be checked.
      const ehraId = String(company.ehraId ?? company.ehraid ?? "").trim();

      if (!ehraId) {
        return buildResponse([formatCompanyShort(company)], warnings);
      }

      const [{ data: companyDetails }, { data: shabPubs }] = await Promise.all([
        makeZefixRequest<CompanyDetails>(`${API_BASE}/${ehraId}/withoutShabPub.json`, null, "GET"),
        makeZefixRequest<ShabPubEntry[]>(`${API_BASE}/${ehraId}/shabPub.json`, null, "GET"),
      ]);

      let resultText = companyDetails
        ? formatCompanyLong(companyDetails)
        : formatCompanyShort(company);

      if (shabPubs && shabPubs.length > 0) {
        const pubLines = shabPubs.map((entry) => {
          const date = entry.shabDate ?? "Unknown date";
          const message = stripHtmlTags(entry.message ?? "");
          return `[${date}] ${message}`;
        });
        resultText += `\n\n### Swiss Official Gazette of Commerce (SOGC) Publications:\n${pubLines.join("\n\n")}`;
      }

      return buildResponse([resultText], warnings);
    }

    if (companies.length < 11) {
      const detailedResults: string[] = [];

      for (let index = 0; index < companies.length; index += 1) {
        const company = companies[index];
        // Fallback to `ehraid` (lowercase) — same inconsistency as in single-company path.
        const ehraId = String(company.ehraId ?? company.ehraid ?? "").trim();

        if (!ehraId) {
          detailedResults.push(formatCompanyShort(company));
          continue;
        }

        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, SEQUENTIAL_REQUEST_DELAY_MS));
        }

        const detailUrl = `${API_BASE}/${ehraId}/withoutShabPub.json`;
        const { data: companyDetails } = await makeZefixRequest<CompanyDetails>(detailUrl, null, "GET");

        if (companyDetails) {
          detailedResults.push(formatCompanyLong(companyDetails));
        } else {
          detailedResults.push(formatCompanyShort(company));
        }
      }

      const header = `Found: ${companies.length} companies`;
      const hint =
        "---\nHint:\nOnly summary information is shown. For in-depth data such as names of legal representatives, registered capital, " +
        "and the full history of changes — search again using the UID of the specific company.\n" +
        "---";
      const body = detailedResults.join("\n---\n");

      return buildResponse([header, hint, body], warnings);
    }

    const formattedCompanies = companies.map((company) => formatCompanyShort(company));

    const header = `Found: ${companies.length} companies`;
    const hint =
      "---\nHint:\n" +
      (hasMoreResults
        ? "Zefix data contain more results than displayed. Add more precise filters (canton, locality, or legal form) to narrow down the search.\n"
        : "") +
      "Only general information is shown. Use the UID of a specific company " +
      "to obtain the full legal address, names of legal representatives, registered capital, " +
      "mergers and acquisitions, auditor, purpose, and the complete history of changes.\n" +
      "---";
    const body = formattedCompanies.join("\n---\n");

    return buildResponse([header, hint, body], warnings);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
