/**
 * Utilidades para generar resúmenes mensuales de mentorías
 */
import { formatDateToYYYYMMDD } from './dateCalculations.js';
/**
 * Genera los resúmenes mensuales a partir de las mentorías procesadas
 */
export function generateMonthlySummaries(mentorships, currentPeriod, previousPeriod) {
    const summaries = [];
    // Resumen del mes actual
    const currentMentorships = mentorships.filter((m) => m.period === 'current');
    const currentSummary = calculateSummaryForPeriod(currentMentorships, 'current', currentPeriod);
    summaries.push(currentSummary);
    // Resumen del mes anterior
    const previousMentorships = mentorships.filter((m) => m.period === 'previous');
    const previousSummary = calculateSummaryForPeriod(previousMentorships, 'previous', previousPeriod);
    summaries.push(previousSummary);
    return summaries;
}
/**
 * Calcula el resumen para un periodo específico
 */
function calculateSummaryForPeriod(mentorships, month, period) {
    let realizadasAPagar = 0;
    let noRealizadasAPagar = 0;
    let noCorresponden = 0;
    mentorships.forEach((mentorship) => {
        switch (mentorship.status) {
            case 'A pagar':
                realizadasAPagar++;
                break;
            case 'No realizada a pagar':
                noRealizadasAPagar++;
                break;
            case 'No corresponde':
                noCorresponden++;
                break;
            // 'No realizada' no se cuenta en los totales
        }
    });
    const total = realizadasAPagar + noRealizadasAPagar;
    return {
        month,
        period: {
            start: formatDateToYYYYMMDD(period.start),
            end: formatDateToYYYYMMDD(period.end),
        },
        realizadasAPagar,
        noRealizadasAPagar,
        total,
        noCorresponden,
    };
}
//# sourceMappingURL=monthlySummaries.js.map