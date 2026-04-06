export interface Finding {
    id: string;
    file: string;
    startLine: number;
    endLine: number;
    severity: 'critical' | 'important' | 'minor' | 'nitpick';
    category: 'security' | 'correctness' | 'best-practices' | 'tests' | 'api-design';
    title: string;
    description: string;
    suggestedFix?: string;
}
export interface ModelReview {
    model: string;
    role: string;
    provider: string;
    findings: Finding[];
    durationMs: number;
    status: 'success' | 'timeout' | 'error';
    error?: string;
}
export interface ConsensusInfo {
    score: number;
    total: number;
    models: string[];
    roles: string[];
    crossRole: boolean;
    crossModel: boolean;
    elevated: boolean;
    original_severity?: string;
    elevation: 'none' | 'cross-role' | 'cross-model' | 'unanimous';
    confidence: number;
    confidenceLabel: 'Very High' | 'High' | 'Medium' | 'Low' | 'Minimal';
    disputed?: boolean;
    disputeDetails?: string;
}
export interface ConsensusFinding extends Finding {
    consensus: ConsensusInfo;
}
export interface DeduplicatedGroup {
    representative: Finding;
    members: Array<{
        finding: Finding;
        model: string;
        role: string;
    }>;
}
export interface ReviewResult {
    reviews: ModelReview[];
    findings: ConsensusFinding[];
    stats: {
        totalReviews: number;
        successfulReviews: number;
        totalRawFindings: number;
        totalDeduped: number;
        durationMs: number;
    };
}
