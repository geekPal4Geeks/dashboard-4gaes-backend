import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { sql } from '@vercel/postgres';
import { Client, LogLevel } from '@notionhq/client';
import { NotionAPI } from 'notion-client';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import dotenv from 'dotenv';
import fetch from 'node-fetch';



dotenv.config();

const app = express();
const urlencodedParser = bodyParser.urlencoded({ extended: false });
app.use(express.json());
app.use(cors());

// Middleware para loguear las solicitudes entrantes
app.use((req, res, next) => {
    // Loguea la solicitud entrante
    console.log(`[Backend Request] Método: ${req.method}, Ruta: ${req.url}, Cuerpo: ${JSON.stringify(req.body)}`);

    // Escucha el evento 'finish' para loguear la respuesta
    res.on('finish', () => {
        const statusType = res.statusCode >= 200 && res.statusCode < 300 ? 'SUCCESS' : 'FAILED';
        const statusMessage = res.statusMessage || ''; // Obtiene el mensaje de estado si está disponible
        console.log(`[Backend Response] ${statusType}: Método: ${req.method}, Ruta: ${req.url}, Estado: ${res.statusCode} ${statusMessage}`);
    });

    next();
});

// Middleware de autenticación
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Malformed token' });
    try {
        const response = await fetch(`${process.env.BREATHCODE_API_URL}/auth/user/me`, {
            headers: { Authorization: `Token ${token}` }
        });
        if (!response.ok) throw new Error('Invalid token');

        const userData = await response.json();
        (req as any).user4GeeksData = userData; // Guarda los datos del usuario en la request
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
} 

// Middleware para validar roles permitidos
function authorizeRoles(notAllowedRoles: string[] = []) {
    const allowedRoles = ['teacher', 'assistant', 'academy_coordinator', 'country_manager'];
    return (req: Request, res: Response, next: NextFunction) => {
      const userRoles = (req as any).user4GeeksData.roles || [];
      // Si el usuario tiene algún rol explícitamente no permitido, negar acceso
      const hasNotAllowedRole = userRoles.some(roleObj =>
        notAllowedRoles.includes(roleObj.role) && roleObj.academy && roleObj.academy.id === 6
      );
      if (hasNotAllowedRole) {
        return res.status(403).json({ message: 'No tienes permisos' });
      }
      // Si el usuario NO tiene al menos uno de los roles permitidos, negar acceso
      const hasAllowedRole = userRoles.some(roleObj =>
        allowedRoles.includes(roleObj.role) && roleObj.academy && roleObj.academy.id === 6
      );
      if (!hasAllowedRole) {
        return res.status(403).json({ message: 'No tienes permisos (rol no permitido)' });
      }
      next();
    };
  }


// Configuración del cliente de Notion oficial
const notion = new Client({
    auth: process.env.NOTION_TOKEN,
    logLevel: LogLevel.DEBUG
});

// Configuración del NotionAPI de react-notion-x
const notionX = new NotionAPI();

app.use(express.static('public'));

app.get('/', function (req, res) {
    res.sendFile(path.join(process.cwd(), 'components', 'home.htm'));
});

// Aplica el middleware a todas las rutas que empiezan con /api
app.use('/api', authMiddleware);

// Endpoint para obtener información de la cohorte
app.post('/api/cohort-info', authorizeRoles(), async (req, res) => {
    try {
        const { cohortId } = req.body;

        if (!cohortId) {
            return res.status(400).json({ error: 'Se requiere el ID de la cohorte' });
        }

        const response = await notion.databases.query({
            database_id: process.env.NOTION_DATABASE_ID || '',
            filter: {
                or: [
                    {
                        property: '4Geeks ID',
                        rich_text: {
                            equals: `${cohortId}`,
                        },
                    },
                ],
            },
        });

        if (!response.results || response.results.length === 0) {
            return res.status(404).json({ error: 'Cohorte no encontrada' });
        }

        res.status(200).json(response.results[0]);
    } catch (error) {
        console.error('Error obteniendo información de Notion:', error);
        res.status(500).json({ error: 'Error al obtener información de la cohorte' });
    }
});

// Nuevo endpoint para obtener una página de cohorte por su ID (desde la base de datos)
app.post('/api/cohort-page-by-id', authorizeRoles(), async (req, res) => {
    try {
        const { pageId } = req.body;

        if (!pageId) {
            return res.status(400).json({ error: 'Se requiere el ID de la página de Notion' });
        }

        const cohortPage = await notion.pages.retrieve({
            page_id: pageId
        });

        if (!cohortPage) {
            return res.status(404).json({ error: 'Página de cohorte no encontrada en Notion' });
        }

        res.status(200).json(cohortPage);
    } catch (error) {
        console.error('Error obteniendo página de cohorte por ID:', error);
        res.status(500).json({ error: 'Error al obtener la página de cohorte por ID' });
    }
});

// endpoint para obtener información de un estudiante específico
app.post('/api/student-info', authorizeRoles(), async (req, res) => {
    try {
        const { studentId } = req.body;

        if (!studentId) {
            return res.status(400).json({ error: 'Se requiere el ID del estudiante' });
        }

        const responseStudent = await notion.pages.retrieve({
            page_id: studentId
        });


        if (!responseStudent) {
            return res.status(404).json({ error: 'Estudiante no encontrado' });
        }
;
        let cohort = null;

        // Extraer el ID de la cohorte
        const cohortRelation = (responseStudent as any).properties?.Cohort?.relation;
        const cohortId = cohortRelation && cohortRelation.length > 0 ? cohortRelation[0].id : null;

        // Si hay cohorte, obtener sus datos
        if (cohortId) {
            cohort = await notion.pages.retrieve({ page_id: cohortId });
        }

        res.status(200).json({
            student: responseStudent,
            cohort
        });

    } catch (error) {
        console.error('Error obteniendo información del estudiante:', error);
        res.status(500).json({ error: 'Error al obtener información del estudiante' });
    }
});

// Endpoint para actualizar una o más propiedades de un estudiante
app.put('/api/update-student-property', authorizeRoles(), async (req, res) => {
    try {
        const { studentId, properties } = req.body;

        if (!studentId || !properties) {
            return res.status(400).json({
                error: 'Se requieren studentId y properties'
            });
        }

        // Si properties es un objeto simple, convertirlo en array
        const propertiesArray = Array.isArray(properties) ? properties : [properties];

        // Obtener la página actual de Notion UNA SOLA VEZ al inicio del endpoint
        const currentPage = await notion.pages.retrieve({
            page_id: studentId
        }) as any;

        // Validar que cada propiedad tenga los campos requeridos
        for (const prop of propertiesArray) {

            if (!prop.propertyName || prop.propertyValue === undefined) {
                return res.status(400).json({
                    error: 'Cada propiedad debe tener propertyName y propertyValue'
                });
            }
        }

        // Propiedades numéricas (Skill review y Absences)
        const numericProperties = [
            'Absences',
            'Responsabilidad (Skill review)',
            'Organización (Skill review)',
            'Capacidad de atención (Skill review)',
            'Dominio de conceptos (Skill review)',
            'Habilidad técnica (Skill review)',
            'Capacidad resolutiva (Skill review)',
            'Trabajo en equipo (Skill review)',
        ];

        // Construir el objeto de actualización
        const propertyUpdates = {};

        for (const prop of propertiesArray) {
            const { propertyName, propertyValue } = prop;

            if (numericProperties.includes(propertyName)) {
                // Asegurarse de que el valor sea un número (o null si es vacío)
                const numericValue = propertyValue === '' || propertyValue === null ? null : Number(propertyValue);
                if (isNaN(numericValue) && numericValue !== null) {
                    return res.status(400).json({
                        error: `El valor para ${propertyName} debe ser un número.`
                    });
                }
                propertyUpdates[propertyName] = {
                    number: numericValue
                };
            }
            // Propiedad multi-select
            else if (propertyName === 'Technical specialties' || propertyName === 'GeekFORCE Sessions') {

                const currentMultiSelectOptions = currentPage.properties[propertyName]?.multi_select || [];
                // Crear un mapa de nombre de etiqueta a su objeto completo (con id, name, color) para búsquedas rápidas
                const existingNotionOptionsMap = new Map<string, { id?: string; name: string; }>();
                currentMultiSelectOptions.forEach(option => {
                    if (option.name) {
                        existingNotionOptionsMap.set(option.name, option);
                    }
                });

                // Normalizar `propertyValue` a un array de tags (pueden ser objetos o strings)
                const incomingTags = Array.isArray(propertyValue) ? propertyValue : [propertyValue];

                // Usar un Map para construir la lista final de tags, asegurando unicidad por nombre
                const finalMultiSelectMap = new Map<string, { id?: string; name?: string; }>();

                incomingTags.forEach(incomingTag => {
                    let tagName: string | undefined;
                    let tagObjectToSend: { id?: string; name?: string; } | null = null;

                    if (typeof incomingTag === 'object' && incomingTag !== null) {
                        tagName = incomingTag.name;
                        if (incomingTag.id) {
                            // Si el tag entrante ya tiene un ID, lo usamos (es un tag existente)
                            tagObjectToSend = { id: incomingTag.id };
                        } else if (tagName) {
                            // Si no tiene ID pero sí nombre, verificamos si existe en Notion para obtener su ID
                            const existingOptionInNotion = existingNotionOptionsMap.get(tagName);
                            if (existingOptionInNotion && existingOptionInNotion.id) {
                                tagObjectToSend = { id: existingOptionInNotion.id };
                            } else {
                                // Es un tag nuevo (o existente sin ID en Notion/frontend), enviamos solo el nombre
                                tagObjectToSend = { name: tagName };
                            }
                        }
                    } else if (typeof incomingTag === 'string') {
                        // Si el tag entrante es solo un string (el nombre)
                        tagName = incomingTag;
                        const existingOptionInNotion = existingNotionOptionsMap.get(tagName);
                        if (existingOptionInNotion && existingOptionInNotion.id) {
                            // Si existe en Notion, usamos su ID
                            tagObjectToSend = { id: existingOptionInNotion.id };
                        } else {
                            // Es un tag nuevo o existente por nombre solamente
                            tagObjectToSend = { name: tagName };
                        }
                    }

                    if (tagName && tagObjectToSend) {
                        // Agregamos al mapa; si el nombre ya existe, se sobrescribe, asegurando unicidad
                        finalMultiSelectMap.set(tagName, tagObjectToSend);
                    }
                });

                // Convertir el Map a un array de objetos listos para la API de Notion
                const multiSelectArray = Array.from(finalMultiSelectMap.values());



                propertyUpdates[propertyName] = {
                    multi_select: multiSelectArray
                };
            }
            else if (propertyName === 'GeekFORCE Stage') {


                propertyUpdates[propertyName] = {
                    status: { name: propertyValue } // Cambiado de select a status
                };
            }
            // Propiedad checkbox
            else if (propertyName === 'Recomendado para TA') {
                propertyUpdates[propertyName] = {
                    checkbox: Boolean(propertyValue)
                };
            }
            // Propiedades de texto enriquecido (por defecto para otros tipos)
            else {
                propertyUpdates[propertyName] = {
                    rich_text: [
                        {
                            text: {
                                content: propertyValue.toString()
                            }
                        }
                    ]
                };
            }
        }

        const updateResponse = await notion.pages.update({
            page_id: studentId,
            properties: propertyUpdates
        });


        if (!updateResponse) {
            return res.status(400).json({ error: 'Error al actualizar las propiedades en Notion (respuesta vacía)' });
        }

        res.status(200).json(updateResponse);
    } catch (error: any) {
        console.error('Error detallado:', {
            mensaje: error.message,
            stack: error.stack,
            response: error.response?.data
        });
        if (error.message === 'validation_error') {
            res.status(400).json({ error: `Error de validación en Notion: ${error.message}` });
        } else {
            res.status(500).json({ error: 'Error interno al actualizar las propiedades del estudiante' });
        }
    }
});

// Endpoint para crear un comentario en la ficha de un estudiante
app.post('/api/create-student-comment', authorizeRoles(), async (req, res) => {
    try {
        const { studentId, comment, notificationData } = req.body;

        if (!studentId || !comment) {
            return res.status(400).json({
                error: 'Se requieren studentId y comment'
            });
        }

        // Crear el comentario en Notion
        const response = await notion.comments.create({
            parent: {
                page_id: studentId
            },
            rich_text: [
                {
                    text: {
                        content: comment
                    }
                }
            ]
        });

        if (!response) {
            return res.status(404).json({ error: 'No se pudo crear el comentario' });
        }

        // Verificar si es una Mock Interview (realizada o cancelada)
        const isMockInterview = comment.includes('Mock Interview') || comment.includes('Mock interview');

        if (isMockInterview) {
            try {
                // Obtener el slack_id del estudiante
                const studentPage = await notion.pages.retrieve({
                    page_id: studentId
                }) as any;

                // Acceder al slack_id y al GeekFORCE Coach de manera segura
                const slackId = studentPage?.properties?.['Slack ID']?.rich_text?.[0]?.text?.content;
                const geekforceCoach = studentPage?.properties?.['GeekFORCE Coach']?.select?.name || '';

                if (slackId) {
                    const message = `<@${slackId}> ${comment}`;

                    // Enviar notificación a Zapier
                    await fetch(process.env.ZAPIER_MOCK_INTERVIEW_WEBHOOK_URL || '', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            message,
                            slack_id: slackId,
                            coach_name: geekforceCoach,
                            channel_id: 'C07KVERC474'
                        })
                    });
                }
            } catch (zapierError) {
                // Solo logueamos el error pero no fallamos la operación principal
                console.error('Error enviando notificación a Zapier:', zapierError);
            }
        }

        // Procesar la notificación original si existe
        if (notificationData && notificationData.type === 'mock_interview_cancellation' && notificationData.slackId) {
            try {
                const message = `Hola! <@${notificationData.slackId}> Nos han informado que has cancelado tu sesión de Mock interview, recuerda que debes reprogramarla para continuar con tu proceso de carreras! Un saludo.`;

                // Enviar notificación a Zapier
                await fetch(process.env.ZAPIER_CANCELLATION_WEBHOOK_URL || '', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        message,
                        slack_id: notificationData.slackId,
                        coach_name: notificationData.coachName,

                    })
                });
            } catch (zapierError) {
                // Solo logueamos el error pero no fallamos la operación principal
                console.error('Error enviando notificación a Zapier:', zapierError);
            }
        }

        res.status(200).json(response);
    } catch (error) {
        console.error('Error creando comentario:', error);
        res.status(500).json({ error: 'Error al crear el comentario' });
    }
});

// Endpoint para buscar un estudiante por correo electrónico
app.post('/api/search-student-by-email', authorizeRoles(), async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Se requiere el correo electrónico del estudiante' });
        }

        const response = await notion.databases.query({
            database_id: process.env.NOTION_STD_DATABASE_ID ?? '',
            filter: {
                property: 'Email',
                email: {
                    equals: email
                }
            }
        });

        if (!response.results || response.results.length === 0) {
            return res.status(404).json({ error: 'Estudiante no encontrado' });
        }

        const student = response.results[0];
        let cohort = null;

        // Extraer el ID de la cohorte
        const cohortRelation = (student as any).properties?.Cohort?.relation;
        const cohortId = cohortRelation && cohortRelation.length > 0 ? cohortRelation[0].id : null;

        // Si hay cohorte, obtener sus datos
        if (cohortId) {
            cohort = await notion.pages.retrieve({ page_id: cohortId });
        }

        res.status(200).json({
            student,
            cohort
        });
    } catch (error) {
        console.error('Error buscando estudiante por correo:', error);
        res.status(500).json({ error: 'Error al buscar el estudiante' });
    }
});

// Endpoint para obtener el contenido de una página de Notion usando notion-client (react-notion-x)
app.post('/api/notion-page', authorizeRoles(), async (req, res) => {
    try {
        const { pageId } = req.body;
        if (!pageId) {
            return res.status(400).json({ error: 'Se requiere el ID de la página de Notion' });
        }

        // Usar NotionAPI de react-notion-x para obtener la página y sus bloques
        const recordMap = await notionX.getPage(pageId);

        if (!recordMap) {
            return res.status(404).json({ error: 'Página no encontrada' });
        }


        res.status(200).json({
            recordMap
        });
    } catch (error) {
        console.error('Error obteniendo contenido de la página de Notion:', error);
        res.status(500).json({ error: 'Error al obtener el contenido de la página' });
    }
});

// Endpoint para cancelar una mentoría
app.post('/api/cancel-mentorship', authorizeRoles(), async (req, res) => {
    try {
        const {
            cancellationDate,
            cancellationNotes,
            cancellationReason,
            mentorName,
            originalMentorshipDate,
            studentId,
            supliedWithOtherStudent,
            mentorshipType
        } = req.body;


        // Validar campos requeridos con mensajes más específicos
        if (!studentId) {
            return res.status(400).json({ error: 'El ID del estudiante es requerido' });
        }
        if (!cancellationDate) {
            return res.status(400).json({ error: 'La fecha de cancelación es requerida' });
        }
        if (!originalMentorshipDate) {
            return res.status(400).json({ error: 'La fecha original de la mentoría es requerida' });
        }
        if (!cancellationReason) {
            return res.status(400).json({ error: 'El motivo de la cancelación es requerido' });
        }
        if (!mentorName) {
            return res.status(400).json({ error: 'El nombre del mentor es requerido' });
        }
        if (supliedWithOtherStudent === undefined) {
            return res.status(400).json({ error: 'El campo supliedWithOtherStudent es requerido' });
        }
        if (!cancellationNotes) {
            return res.status(400).json({ error: 'Las notas de cancelación son requeridas' });
        }
        if (!mentorshipType) {
            return res.status(400).json({ error: 'El tipo de mentoría es requerido' });
        }


        // Convertir supliedWithOtherStudent a booleano si es necesario
        const supliedWithOtherStudentBool = typeof supliedWithOtherStudent === 'string'
            ? supliedWithOtherStudent.toLowerCase() === 'true'
            : Boolean(supliedWithOtherStudent);

        const response = await notion.pages.create({
            parent: {
                database_id: process.env.NOTION_CANCELLATIONS_DATABASE_ID || ''
            },
            properties: {
                'Estudiante': {
                    relation: [{
                        id: studentId
                    }]
                },
                'Fecha y hora de cancelación': {
                    date: {
                        start: cancellationDate
                    }
                },
                'Fecha y hora de mentoría': {
                    date: {
                        start: originalMentorshipDate
                    }
                },
                'Motivo de reprogramación': {
                    select: {
                        name: cancellationReason
                    }
                },
                'Mentor/a': {
                    select: {
                        name: mentorName
                    }
                },
                'Suplido con otro alumno': {
                    checkbox: supliedWithOtherStudentBool
                },
                'Notas': {
                    rich_text: [{
                        text: {
                            content: cancellationNotes
                        }
                    }]
                },
                'Tipo de mentoría': {
                    select: {
                        name: mentorshipType
                    }
                }
            }
        });

        // console.log('Respuesta de Notion:', JSON.stringify(response, null, 2));
        console.log('ID de la página creada:', response.id);

        res.status(200).json({
            message: 'Cancelación registrada exitosamente',
            cancellation: response,
            pageUrl: response.id
        });
    } catch (error) {
        console.error('Error registrando cancelación de mentoría:', error);
        res.status(500).json({ error: 'Error al registrar la cancelación de la mentoría' });
    }
});

app.listen(5000, () => console.log('Server ready on port 5000.'));

export default app;
