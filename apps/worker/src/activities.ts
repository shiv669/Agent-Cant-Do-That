export async function logStep(message: string): Promise<void> {
  console.log(`[workflow-step] ${message}`);
}
