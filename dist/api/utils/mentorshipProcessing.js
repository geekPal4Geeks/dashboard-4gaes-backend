/**
 * Utilidades para procesar y calcular el estado de las mentorías
 */
import { calcularHorasPagas, MOCK_SERVICE } from './calculoHoras.js';
// Servicios pagados (basado en mentorshipCount.js)
export const PAID_SERVICES = [
    'Full-Stack: Ejercicios',
    'Data Science: Ejercicios',
    'Full-Stack: Proyectos Finales',
    'Ciberseguridad: Ejercicios',
];
/**
 * Obtiene el nombre del servicio de una sesión, buscando en diferentes campos posibles
 */
export function getServiceName(session) {
    // Intentar diferentes campos posibles en orden de prioridad
    // 1. Campo directo service.name (estructura antigua)
    if (session.service?.name)
        return session.service.name;
    // 2. Campo directo service_name
    if (session.service_name)
        return session.service_name;
    // 3. Campos alternativos ligados a la sesión
    if (session.service?.slug)
        return session.service.slug;
    if (session.service_slug)
        return session.service_slug;
    return undefined;
}
/**
 * Obtiene la hora de inicio de la mentoría (la más tardía entre started_at y mentor_joined_at)
 * También intenta usar otros campos de fecha si los principales no están disponibles
 */
export function getMentorshipStartTime(session) {
    // Campos principales
    const dates = [session.started_at, session.mentor_joined_at]
        .map((d) => (d ? new Date(d) : null))
        .filter((d) => d !== null && !isNaN(d.getTime()));
    // Si no hay fechas principales, intentar otros campos posibles
    if (dates.length === 0) {
        // Buscar cualquier campo que contenga "start" o "begin"
        const alternativeFields = Object.keys(session).filter(key => key.toLowerCase().includes('start') ||
            key.toLowerCase().includes('begin') ||
            key.toLowerCase().includes('created'));
        for (const field of alternativeFields) {
            const value = session[field];
            if (value) {
                const date = new Date(value);
                if (!isNaN(date.getTime())) {
                    dates.push(date);
                }
            }
        }
    }
    if (dates.length === 0)
        return null;
    // Retornar la más tardía
    return dates.sort((a, b) => b.getTime() - a.getTime())[0];
}
/**
 * Obtiene la hora de fin de la mentoría (la más temprana entre ended_at y mentee_left_at)
 */
export function getMentorshipEndTime(session) {
    const dates = [session.ended_at, session.mentee_left_at]
        .map((d) => (d ? new Date(d) : null))
        .filter((d) => d !== null && !isNaN(d.getTime()));
    if (dates.length === 0)
        return null;
    // Retornar la más temprana
    return dates.sort((a, b) => a.getTime() - b.getTime())[0];
}
/**
 * Calcula la duración en minutos entre dos fechas
 */
export function calculateDuration(startTime, endTime) {
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime()))
        return 0;
    return Math.round((endTime.getTime() - startTime.getTime()) / 60000);
}
/**
 * Determina el tipo de servicio
 */
export function determineServiceType(serviceName) {
    if (!serviceName)
        return 'Mentoría';
    if (serviceName === MOCK_SERVICE || serviceName.toLowerCase().includes('mock')) {
        return 'Mock interview';
    }
    return 'Mentoría';
}
/**
 * Determina si una mentoría se debe pagar
 */
export function shouldPayMentorship(minutos, serviceName) {
    return calcularHorasPagas(minutos, serviceName) > 0;
}
/**
 * Verifica si es un servicio pagado
 */
function isPaidService(serviceName) {
    if (!serviceName)
        return true;
    return PAID_SERVICES.includes(serviceName) || serviceName === MOCK_SERVICE;
}
/**
 * Calcula el status de una mentoría
 */
export function calculateMentorshipStatus(session) {
    const startTime = getMentorshipStartTime(session);
    const endTime = getMentorshipEndTime(session);
    // Si no hay fecha de inicio, no se puede procesar
    if (!startTime) {
        return 'No realizada';
    }
    // Caso especial: mentoría FAILED pero realizada (error de plataforma)
    // Estas se marcan como "A pagar" si cumplen los criterios porque sí se realizaron
    const esFailedPeroRealizada = session.status === 'FAILED' &&
        session.summary === 'Automatically closed because its ends was two hours ago or more' &&
        session.started_at &&
        session.mentee_left_at;
    // Si no hay fecha de fin, es una mentoría no realizada
    if (!endTime) {
        if (session.status === 'FAILED') {
            return 'No realizada';
        }
        // Si está COMPLETED pero no tiene endTime, podría ser un error
        return 'No realizada';
    }
    // Calcular duración
    const minutos = calculateDuration(startTime, endTime);
    // Obtener nombre del servicio usando la función helper
    const serviceName = getServiceName(session);
    // Si es FAILED pero realizada, verificar criterios de pago
    // Estas se marcan como "A pagar" si cumplen los criterios (duración > 15 min y servicio pagado)
    if (esFailedPeroRealizada) {
        if (minutos > 15 && isPaidService(serviceName)) {
            return 'A pagar';
        }
        return 'No corresponde';
    }
    // Si dura menos de 15 minutos, no corresponde pago
    if (minutos <= 15) {
        return 'No corresponde';
    }
    // Verificar si es un servicio pagado
    const isPaid = isPaidService(serviceName);
    // Debug: Log para identificar problemas
    if (!isPaid && serviceName) {
        console.log(`⚠️ [calculateMentorshipStatus] Servicio no pagado: "${serviceName}" (minutos: ${minutos})`);
        console.log(`   Servicios pagados disponibles:`, PAID_SERVICES);
    }
    if (!isPaid) {
        return 'No corresponde';
    }
    // Si se debe pagar, retornar "A pagar"
    const shouldPay = shouldPayMentorship(minutos, serviceName);
    if (!shouldPay) {
        console.log(`⚠️ [calculateMentorshipStatus] shouldPayMentorship retornó false para: "${serviceName}" (minutos: ${minutos})`);
    }
    if (shouldPay) {
        return 'A pagar';
    }
    return 'No corresponde';
}
/**
 * Obtiene el nombre completo del estudiante
 */
export function getStudentName(session) {
    const mentee = session.mentee;
    if (!mentee)
        return 'Estudiante desconocido';
    const firstName = mentee.first_name || '';
    const lastName = mentee.last_name || '';
    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    return fullName || 'Estudiante desconocido';
}
//# sourceMappingURL=mentorshipProcessing.js.map