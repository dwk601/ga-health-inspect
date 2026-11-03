export type Facility = { id: string; name: string | null; address: string | null; phone: string | null; permitType: string | null; permitNumber: string | null; lastInspectionDate: string | null; lastInspectionScore: number | null; googlePlaces: string | null }
export type Point = { id: string; name: string | null; permitType: string | null; score: number | null; coordinates: [number, number] }
export type Snapshot = { points: Point[]; permitChoices: string[]; generatedAt: string }
export type Violation = { sourceKey: string; codeTitle: string | null; regulation: string | null; points: number | null; corrected: boolean | null; repeat: boolean | null; notes: string | null }
export type Inspection = { id: string; inspectionDate: string | null; purpose: string | null; score: number | null; inspector: string | null; printableUrl: string | null; violations: Violation[] }
export type Detail = { facility: Facility; inspections: Inspection[]; community?: { ratingAverage: number | null; ratingCount: number } }
export type Contribution = { id: string; owner: string; facility_id: string; authorName: string; rating?: number; body?: string; created: string }
