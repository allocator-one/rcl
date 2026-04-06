export interface Role {
  name: string;
  systemPrompt: string;
  focus: string[];
  severityBias?: Record<string, number>;
  description: string;
  isSpecialized: boolean;
}

export interface ReviewAssignment {
  model: string;
  role: Role;
  provider: string;
}
