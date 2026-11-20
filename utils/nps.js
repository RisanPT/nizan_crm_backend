// NET PROMOTER SCORE from the 0–10 "would you recommend us" answers: promoters 9–10, passives 7–8, detractors 0–6;
// NPS = % promoters − % detractors (−100 … 100). No answers → null (no score, not 0).
// Shared by the review analytics (controllers/reviewController.js) and the CRM figures (utils/crmStats.js). Pure.

export const npsOf = (values) => {
  const answers = values.filter((v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))).map(Number);
  const promoters = answers.filter((v) => v >= 9).length;
  const passives = answers.filter((v) => v >= 7 && v <= 8).length;
  const detractors = answers.filter((v) => v <= 6).length;
  return {
    nps: answers.length ? Math.round(((promoters - detractors) / answers.length) * 100) : null,
    promoters,
    passives,
    detractors,
    responses: answers.length,
  };
};
