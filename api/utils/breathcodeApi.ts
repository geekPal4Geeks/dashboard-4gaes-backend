/**
 * Utilidades para interactuar con la API de BreatheCode
 */

import fetch from 'node-fetch';

/**
 * Obtiene las sesiones de mentoría del mentor autenticado
 * @param token Token de autenticación
 * @param academyId ID de la academia (default: 6)
 * @returns Array de sesiones de mentoría
 */
export async function fetchMentorSessions(
  token: string,
  academyId: string = '6'
): Promise<any[]> {
  const apiUrl = process.env.BREATHCODE_API_URL;
  if (!apiUrl) {
    throw new Error('BREATHCODE_API_URL no está configurado en las variables de entorno');
  }

  const url = `${apiUrl}/mentorship/user/me/session`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${token}`,
        'Academy': academyId,
      },
    });

    if (!response.ok) {
      throw new Error(`Error al obtener mentorías: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    
    // La API puede retornar un array directamente o un objeto con results
    if (Array.isArray(data)) {
      return data;
    }
    
    if (data && typeof data === 'object' && 'results' in data && Array.isArray(data.results)) {
      return data.results;
    }
    
    return [];
  } catch (error: any) {
    console.error('Error al obtener mentorías del API:', error.message);
    throw error;
  }
}

