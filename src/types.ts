// ── core data model for schoolyank ──

export interface Teacher {
  firstName: string;
  lastName: string;
  email: string | null;
  role: string;
  department: string | null;
  phoneExtension: string | null;
  linkedinUrl: string | null;
  sources: DataSource[];
  confidence: ConfidenceScore;
}

export interface SchoolInfo {
  name: string;
  url: string;
  address: Address | null;
  phone: string | null;
  district: string | null;
  ncesId: string | null;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  zip: string;
  source: "nces" | "school_website" | "inferred";
}

export type DataSource =
  | "school_website"
  | "nces"
  | "linkedin"
  | "district_website"
  | "inferred";

export type ConfidenceScore = 1 | 2 | 3 | 4 | 5;

export interface ScrapeResult {
  school: SchoolInfo;
  teachers: Teacher[];
  metadata: {
    scrapedAt: string;
    durationMs: number;
    pagesVisited: number;
    browserUseSessionId: string | null;
    warnings: string[];
  };
}

// raw shape returned by the AI extraction before validation
export interface RawTeacherData {
  name: string;
  email?: string;
  role?: string;
  department?: string;
  phone?: string;
}

// nces api response shape (subset of fields we care about)
export interface NCESSchoolRecord {
  school_name: string;
  ncessch: string;
  street_mailing: string;
  city_mailing: string;
  state_mailing: string;
  zip_mailing: string;
  street_location: string;
  city_location: string;
  state_location: string;
  zip_location: string;
  phone: string;
  lea_name: string;
  teachers_fte: number;
  school_level: number;
  fips: number;
}

// config passed through the pipeline
export interface ScrapeConfig {
  schoolUrl: string;
  enableLinkedin: boolean;
  linkedinProfileId?: string;
  outputPath: string;
}
