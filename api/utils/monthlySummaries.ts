/**
 * Utilidades para generar resúmenes mensuales de mentorías
 */

import { MentorshipStatus } from './mentorshipProcessing.js';
import { formatDateToYYYYMMDD } from './dateCalculations.js';

export interface ProcessedMentorship {
  id: string;
  student: string;
  service: 'Mock interview' | 'Mentoría';
  startTime: string;
  endTime: string;
  duration: number;
  status: MentorshipStatus;
  canRequestReview: boolean;
  period: 'current' | 'previous';
}

export interface MonthlySummary {
  month: 'current' | 'previous';
  period: {
    start: string;
    end: string;
  };
  realizadasAPagar: number;
  noRealizadasAPagar: number;
  total: number;
  noCorresponden: number;
}

/**
 * Genera los resúmenes mensuales a partir de las mentorías procesadas
 */
export function generateMonthlySummaries(
  mentorships: ProcessedMentorship[],
  currentPeriod: { start: Date; end: Date },
  previousPeriod: { start: Date; end: Date }
): MonthlySummary[] {
  const summaries: MonthlySummary[] = [];

  // Resumen del mes actual
  const currentMentorships = mentorships.filter((m) => m.period === 'current');
  const currentSummary = calculateSummaryForPeriod(
    currentMentorships,
    'current',
    currentPeriod
  );
  summaries.push(currentSummary);

  // Resumen del mes anterior
  const previousMentorships = mentorships.filter((m) => m.period === 'previous');
  const previousSummary = calculateSummaryForPeriod(
    previousMentorships,
    'previous',
    previousPeriod
  );
  summaries.push(previousSummary);

  return summaries;
}

/**
 * Calcula el resumen para un periodo específico
 */
function calculateSummaryForPeriod(
  mentorships: ProcessedMentorship[],
  month: 'current' | 'previous',
  period: { start: Date; end: Date }
): MonthlySummary {
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

