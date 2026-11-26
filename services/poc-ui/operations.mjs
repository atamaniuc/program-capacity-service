const requestFields = `
  id programId invoiceId state reason reservationId paymentId
  amount { value currency }
  invoice { id description }
  buyer { name region }
  payment { status }
`;
export const recentQuery = `query RecentFundingRequests {
  recentFundingRequests(limit: 20) { ${requestFields} }
}`;
export const createMutation = `mutation RunScenario($input: CreateFundingRequestInput!, $key: String!) {
  createFundingRequest(input: $input, idempotencyKey: $key) { id state }
}`;
