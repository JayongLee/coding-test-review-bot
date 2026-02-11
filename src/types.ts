export type SupportedSite = "BOJ" | "PROGRAMMERS";

export interface PrProblemMetadata {
  site?: SupportedSite;
  problemNumber?: string;
  problemUrl?: string;
  language?: string;
  runtime?: string;
  memory?: string;
  submittedAt?: string;
}

export interface CrawledProblem {
  title: string;
  problemUrl: string;
  classification: string[];
  descriptionHtml: string;
  inputHtml: string;
  outputHtml: string;
}
