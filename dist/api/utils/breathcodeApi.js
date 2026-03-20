/**
 * Utilidades para interactuar con la API de BreatheCode
 */
import fetch from 'node-fetch';
async function fetchSessionsForAcademy(token, academyId, apiUrl) {
    const url = `${apiUrl}/mentorship/user/me/session`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Token ${token}`,
            'Academy': academyId,
        },
    });
    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new Error(`BREATHCODE_AUTH_${response.status}`);
        }
        console.error(`Error al obtener mentorias para academy ${academyId}: ${response.status} ${response.statusText}`);
        return [];
    }
    const data = await response.json();
    if (Array.isArray(data)) {
        return data;
    }
    if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
        return data.results;
    }
    return [];
}
/**
 * Obtiene las sesiones de mentoria del mentor autenticado desde una o mas academias.
 * Realiza peticiones en paralelo y combina los resultados.
 * @param token Token de autenticacion
 * @param academyIds IDs de las academias (default: ['6', '7'])
 * @returns Array combinado de sesiones de mentoria
 */
export async function fetchMentorSessions(token, academyIds = ['6', '7']) {
    const apiUrl = process.env.BREATHCODE_API_URL;
    if (!apiUrl) {
        throw new Error('BREATHCODE_API_URL no esta configurado en las variables de entorno');
    }
    try {
        const results = await Promise.all(academyIds.map(id => fetchSessionsForAcademy(token, id, apiUrl)));
        return results.flat();
    }
    catch (error) {
        console.error('Error al obtener mentorias del API:', error.message);
        throw error;
    }
}
//# sourceMappingURL=breathcodeApi.js.map