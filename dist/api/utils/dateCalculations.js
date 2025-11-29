/**
 * Utilidades para calcular fechas de periodos académicos
 * Basado en la lógica de mentorshipCount.js
 */
/**
 * Calcula el último viernes del mes
 */
export function getLastFriday(year, month) {
    const lastDay = new Date(year, month + 1, 0);
    lastDay.setHours(0, 0, 0, 0);
    const diff = (lastDay.getDay() + 7 - 5) % 7;
    lastDay.setDate(lastDay.getDate() - diff);
    return lastDay;
}
/**
 * Calcula el lunes anterior a una fecha dada
 */
export function getPreviousMonday(date) {
    const d = new Date(date);
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return monday;
}
/**
 * Formatea una fecha a YYYY-MM-DD
 */
export function formatDateToYYYYMMDD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
/**
 * Calcula las fechas de inicio y fin para el periodo actual (mes actual)
 */
export function getCurrentPeriodDates() {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    const lastFridayThisMonth = getLastFriday(thisYear, thisMonth);
    const endDate = getPreviousMonday(lastFridayThisMonth);
    // Ajustar endDate para que sea el final del día
    endDate.setHours(23, 59, 59, 999);
    // El inicio del periodo actual es el lunes anterior al último viernes del mes anterior
    const prevMonth = thisMonth === 0 ? 11 : thisMonth - 1;
    const prevMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;
    const lastFridayPrevMonth = getLastFriday(prevMonthYear, prevMonth);
    const startDate = getPreviousMonday(lastFridayPrevMonth);
    return { start: startDate, end: endDate };
}
/**
 * Calcula las fechas de inicio y fin para el periodo anterior (mes anterior)
 */
export function getPreviousPeriodDates() {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    const prevMonth = thisMonth === 0 ? 11 : thisMonth - 1;
    const prevMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;
    // El fin del periodo anterior es el lunes anterior al último viernes del mes anterior
    const lastFridayPrevMonth = getLastFriday(prevMonthYear, prevMonth);
    const endDate = getPreviousMonday(lastFridayPrevMonth);
    endDate.setHours(23, 59, 59, 999);
    // El inicio del periodo anterior es el lunes anterior al último viernes del mes anterior al anterior
    const prevPrevMonth = prevMonth === 0 ? 11 : prevMonth - 1;
    const prevPrevMonthYear = prevMonth === 0 ? prevMonthYear - 1 : prevMonthYear;
    const lastFridayPrevPrevMonth = getLastFriday(prevPrevMonthYear, prevPrevMonth);
    const startDate = getPreviousMonday(lastFridayPrevPrevMonth);
    return { start: startDate, end: endDate };
}
/**
 * Calcula las fechas de inicio y fin para el periodo mensual actual (del primer al último día del mes)
 */
export function getCurrentMonthlyPeriodDates() {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    // Primer día del mes actual a las 00:00:00
    const startDate = new Date(thisYear, thisMonth, 1);
    startDate.setHours(0, 0, 0, 0);
    // Último día del mes actual a las 23:59:59
    const endDate = new Date(thisYear, thisMonth + 1, 0);
    endDate.setHours(23, 59, 59, 999);
    return { start: startDate, end: endDate };
}
/**
 * Calcula las fechas de inicio y fin para el periodo mensual anterior (del primer al último día del mes anterior)
 */
export function getPreviousMonthlyPeriodDates() {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    const prevMonth = thisMonth === 0 ? 11 : thisMonth - 1;
    const prevMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;
    // Primer día del mes anterior a las 00:00:00
    const startDate = new Date(prevMonthYear, prevMonth, 1);
    startDate.setHours(0, 0, 0, 0);
    // Último día del mes anterior a las 23:59:59
    const endDate = new Date(prevMonthYear, prevMonth + 1, 0);
    endDate.setHours(23, 59, 59, 999);
    return { start: startDate, end: endDate };
}
//# sourceMappingURL=dateCalculations.js.map