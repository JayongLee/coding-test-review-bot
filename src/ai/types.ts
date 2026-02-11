export interface ReviewTarget {
  path: string;
  patch: string;
  addedLines: number[];
  content: string;
}

export interface AiReviewInput {
  problemMarkdown: string;
  prBody: string;
  language: string;
  askRequest?: string;
  changedCodePrompt: string;
  reviewTargets: ReviewTarget[];
}

export interface InlineSuggestion {
  path: string;
  line: number;
  body: string;
}

export interface AiReviewResult {
  summaryMarkdown: string;
  answerCode: string;
  inlineSuggestions: InlineSuggestion[];
}

export interface AiProvider {
  generateReview(input: AiReviewInput): Promise<AiReviewResult | null>;
}
