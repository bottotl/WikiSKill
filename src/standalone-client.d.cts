export type WikiSkillEnvelope = {
  success: boolean;
  data: unknown;
  warnings: string[];
  blockers: string[];
  nextActions: string[];
};

export type WikiSkillExecutionResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type WikiSkillExecute = (
  executable: string,
  args: string[]
) => Promise<WikiSkillExecutionResult>;

export declare function resolveStandaloneWikiSkillExecutable(
  env?: NodeJS.ProcessEnv
): string;

export declare class WikiSkillStandaloneClient {
  constructor(options?: { executable?: string; execute?: WikiSkillExecute });
  invoke(args: string[]): Promise<WikiSkillEnvelope>;
}
