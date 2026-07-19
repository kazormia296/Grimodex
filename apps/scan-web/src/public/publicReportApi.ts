export interface PublicReportApi {
  getPublicReport(publicReportId: string): Promise<unknown>;
  reportPublicAbuse(publicReportId: string, reason: string): Promise<void>;
}
