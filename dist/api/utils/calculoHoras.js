/**
 * Utilidad para el cálculo de horas pagas según tipo de servicio
 * Convertido de calculoHoras.js a TypeScript
 */
export const MOCK_SERVICE = 'GeekFORCE: Mock Interview';
/**
 * Calcula las horas pagas según la duración y el tipo de servicio
 * @param minutos Duración de la mentoría en minutos
 * @param serviceName Nombre del servicio
 * @returns Número de horas pagas (0, 1)
 */
export function calcularHorasPagas(minutos, serviceName) {
    if (minutos <= 15)
        return 0;
    if (serviceName === MOCK_SERVICE) {
        // Mock Interview: máximo 1 hora
        return 1;
    }
    // Nueva regla: Mentorías normales pagan siempre 1 hora si superan 15 minutos
    return 1;
}
//# sourceMappingURL=calculoHoras.js.map