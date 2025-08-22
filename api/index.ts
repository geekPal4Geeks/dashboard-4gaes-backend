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
    const allowedRoles = ['teacher', 'assistant', 'academy_coordinator', 'country_manager', 'career_support'];
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

// Middleware específico para mentores (solo teachers y coordinadores)
// function authorizeMentors() {
//     const mentorRoles = ['teacher', 'academy_coordinator', 'country_manager'];
//     return (req: Request, res: Response, next: NextFunction) => {
//         const userRoles = (req as any).user4GeeksData.roles || [];
//         // Si el usuario tiene al menos uno de los roles de mentor, permitir acceso
//         const hasMentorRole = userRoles.some(roleObj =>
//             mentorRoles.includes(roleObj.role) && roleObj.academy && roleObj.academy.id === 6
//         );
//         if (!hasMentorRole) {
//             return res.status(403).json({ message: 'Solo los mentores pueden acceder a esta información' });
//         }
//         next();
//     };
// }

function authorizeTeachersOrAssistants() {
    const allowed = ['teacher', 'assistant'];
    return (req: Request, res: Response, next: NextFunction) => {
        const roles = (req as any).user4GeeksData?.roles || [];
        const hasAllowed = roles.some((r: any) => allowed.includes(r.role));
        if (!hasAllowed) return res.status(403).json({ message: 'Requiere rol teacher o assistant' });
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

        if (!isISODateString(cancellationDate) || !isISODateString(originalMentorshipDate)) {
            return res.status(400).json({ error: 'Las fechas deben estar en formato ISO (YYYY-MM-DDTHH:mm)' });
        }


        // Convertir supliedWithOtherStudent a booleano si es necesario
        const supliedWithOtherStudentBool = typeof supliedWithOtherStudent === 'string'
            ? supliedWithOtherStudent.toLowerCase() === 'true'
            : Boolean(supliedWithOtherStudent);

        const cancellationDateISO = cancellationDate;
        const originalMentorshipDateISO = originalMentorshipDate;

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
                        start: cancellationDateISO
                    }
                },
                'Fecha y hora de mentoría': {
                    date: {
                        start: originalMentorshipDateISO
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

// Endpoint para obtener los comentarios de un estudiante
app.post('/api/student-comments', authorizeRoles(), async (req, res) => {
    try {
        const { studentId } = req.body;

        if (!studentId) {
            return res.status(400).json({ error: 'Se requiere el ID del estudiante (block_id)' });
        }

        const response = await notion.comments.list({
            block_id: studentId,
        });

        if (!response.results || response.results.length === 0) {
            return res.status(404).json({ error: 'No se encontraron comentarios para este estudiante' });
        }

        res.status(200).json(response.results);
    } catch (error) {
        console.error('Error obteniendo comentarios de Notion:', error);
        res.status(500).json({ error: 'Error al obtener los comentarios del estudiante' });
    }
});

// Endpoint para obtener los comentarios de una evaluación NPS
app.post('/api/nps-comments', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const { npsId } = req.body;

        if (!npsId) {
            return res.status(400).json({ error: 'Se requiere el NPS ID' });
        }

        // Verificar que la evaluación pertenece al mentor autenticado
        const NPS_DB = process.env.NOTION_NPS_DATABASE_ID || '';
        if (!NPS_DB) {
            return res.status(500).json({ error: 'Falta NOTION_NPS_DATABASE_ID en variables de entorno' });
        }

        // Obtener el mentorId del usuario autenticado
        let mentorId: string;
        try {
            mentorId = await resolveMentorIdFromReq(req);
        } catch (error: any) {
            return res.status(400).json({ error: error.message });
        }

        // Buscar la evaluación por NPS ID (título)
        const evaluationQuery = await notion.databases.query({
            database_id: NPS_DB,
            filter: {
                property: 'NPS ID',
                title: {
                    equals: npsId.toString()
                }
            }
        });

        if (!evaluationQuery.results || evaluationQuery.results.length === 0) {
            return res.status(404).json({ error: 'Evaluación NPS no encontrada con ese NPS ID' });
        }

        const evaluation = evaluationQuery.results[0] as any;
        const notionPageId = evaluation.id;

        console.log('🔍 [NPS Comments] Buscando comentarios para:');
        console.log('   - NPS ID:', npsId);
        console.log('   - Notion Page ID:', notionPageId);

        // Obtener comentarios de la página NPS
        const response = await notion.comments.list({
            block_id: notionPageId,
        });

        console.log('📝 [NPS Comments] Comentarios encontrados:', response.results?.length || 0);
        if (response.results && response.results.length > 0) {
            console.log('   - Comentarios:', JSON.stringify(response.results, null, 2));
        }

        if (!response.results || response.results.length === 0) {
            return res.status(200).json({
                comments: [],
                message: 'No se encontraron comentarios para esta evaluación NPS'
            });
        }

        // Enriquecer comentarios con información del autor
        const enrichedComments = await Promise.all(
            response.results.map(async (comment: any) => {
                try {
                    const authorId = comment.created_by?.id;
                    if (authorId) {
                        const author = await notion.users.retrieve({ user_id: authorId });
                        return {
                            ...comment,
                            author: {
                                id: author.id,
                                name: author.name,
                                avatar_url: author.avatar_url,
                                type: author.type
                            }
                        };
                    }
                    return comment;
                } catch (error) {
                    console.error('Error obteniendo información del autor:', error);
                    return comment;
                }
            })
        );

        console.log('✅ [NPS Comments] Respuesta final:');
        console.log('   - NPS ID:', npsId);
        console.log('   - Notion Page ID:', notionPageId);
        console.log('   - Total comentarios:', enrichedComments.length);
        console.log('   - Comentarios enriquecidos:', JSON.stringify(enrichedComments, null, 2));

        res.status(200).json({
            comments: enrichedComments,
            npsId: npsId,
            notionPageId: notionPageId,
            totalComments: enrichedComments.length
        });

    } catch (error: any) {
        console.error('Error obteniendo comentarios de NPS:', error);

        if (error.code === 'object_not_found') {
            return res.status(404).json({
                error: 'Evaluación NPS no encontrada'
            });
        }

        res.status(500).json({
            error: 'Error al obtener los comentarios de la evaluación NPS',
            details: error.message
        });
    }
});

// Endpoint para obtener un usuario de Notion por su ID
app.post('/api/notion-user', authorizeRoles(), async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'Se requiere el ID del usuario de Notion' });
        }

        const user = await notion.users.retrieve({
            user_id: userId,
        });

        if (!user) {
            return res.status(404).json({ error: 'Usuario de Notion no encontrado' });
        }

        res.status(200).json(user);
    } catch (error) {
        console.error('Error obteniendo usuario de Notion:', error);
        res.status(500).json({ error: 'Error al obtener el usuario de Notion' });
    }
});

// Helper para consultar todas las páginas de una base de datos de Notion con paginación
async function notionQueryAll(databaseId: string, filter: any, sorts?: any[]) {
    const results: any[] = [];
    let cursor: string | undefined = undefined;

    do {
        const page = await notion.databases.query({
            database_id: databaseId,
            filter,
            sorts,
            start_cursor: cursor
        } as any);
        results.push(...page.results);
        cursor = (page as any).next_cursor || undefined;
    } while (cursor);

    return results;
}

// Helper para calcular métricas NPS
function computeNps(scores: number[]) {
    if (!scores.length) return { nps: 0, avg: 0, promoters: 0, passives: 0, detractors: 0, count: 0 };
    const promoters = scores.filter(s => s >= 9).length;
    const detractors = scores.filter(s => s <= 6).length;
    const passives = scores.length - promoters - detractors;
    const nps = Math.round(((promoters / scores.length) - (detractors / scores.length)) * 100);
    const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    return { nps, avg, promoters, passives, detractors, count: scores.length };
}

async function resolveMentorIdFromReq(req: Request): Promise<string> {
    const email = (req as any).user4GeeksData?.email;
    if (!email) throw new Error('No se encontró email en el token');

    const MENTORS_DB = process.env.NOTION_MENTORS_DATABASE_ID || '';
    if (!MENTORS_DB) throw new Error('Falta NOTION_MENTORS_DATABASE_ID');

    const result = await notion.databases.query({
        database_id: MENTORS_DB,
        filter: { property: 'Correo', email: { equals: email } }
    });

    if (!result.results?.length) throw new Error('Mentor no encontrado');
    return result.results[0].id; // <- Este es el mismo id que ves en /api/mentors/me
}

// Endpoint para obtener NPS de un mentor
app.post('/api/mentor-nps', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const { mentorId: mentorIdFromBody, startDate, endDate, includePast = true } = req.body;

        let mentorId = mentorIdFromBody;
        if (!mentorId) {
            mentorId = await resolveMentorIdFromReq(req);
        }

        const NPS_DB = process.env.NOTION_NPS_DATABASE_ID || '';
        if (!NPS_DB) {
            return res.status(500).json({ error: 'Falta NOTION_NPS_DATABASE_ID en variables de entorno' });
        }

        // Determinar el rol del usuario autenticado
        const userRoles = (req as any).user4GeeksData?.roles || [];
        const isAssistant = userRoles.some((roleObj: any) =>
            roleObj.role === 'assistant' && roleObj.academy && roleObj.academy.id === 6
        );
        const isTeacher = userRoles.some((roleObj: any) =>
            roleObj.role === 'teacher' && roleObj.academy && roleObj.academy.id === 6
        );

        // Construir filtro base según el rol
        let filter: any;

        if (isAssistant) {
            // Para assistants, usar la propiedad T.A.
            filter = {
                and: [
                    {
                        property: 'T.A.',
                        rollup: {
                            any: {
                                relation: {
                                    contains: mentorId
                                }
                            }
                        }
                    }
                ]
            };
        } else {
            // Para teachers, usar la propiedad Teacher (comportamiento actual)
            filter = {
                and: [
                    {
                        property: 'Teacher',
                        rollup: {
                            any: {
                                relation: {
                                    contains: mentorId
                                }
                            }
                        }
                    }
                ]
            };
        }

        // Añadir filtros de fecha si se proporcionan (usando NPS ID como aproximación)
        if (startDate) {
            filter.and.push({
                property: 'NPS ID',
                title: {
                    starts_with: startDate.substring(0, 7) // YYYY-MM
                }
            });
        }

        if (endDate) {
            filter.and.push({
                property: 'NPS ID',
                title: {
                    starts_with: endDate.substring(0, 7)
                }
            });
        }

        console.log('🔍 [Mentor NPS] Filtro construido:');
        console.log('   - Rol detectado:', isAssistant ? 'Assistant' : 'Teacher');
        console.log('   - Mentor ID:', mentorId);
        console.log('   - Filtro:', JSON.stringify(filter, null, 2));

        // Obtener todas las páginas de NPS del mentor
        const pages = await notionQueryAll(NPS_DB, filter);

        // Obtener comentarios para todas las evaluaciones
        const commentsMap = new Map<string, any[]>();

        for (const page of pages) {
            const props = (page as any).properties || {};
            const npsId = props['NPS ID']?.title?.[0]?.plain_text || '';

            if (npsId) {
                try {
                    const notionPageId = page.id;
                    const commentsResponse = await notion.comments.list({
                        block_id: notionPageId,
                    });

                    if (commentsResponse.results && commentsResponse.results.length > 0) {
                        // Tomar solo el primer comentario
                        const firstComment = commentsResponse.results[0];
                        const firstCommentText = firstComment.rich_text?.[0]?.plain_text || '';

                        // Enriquecer el primer comentario con información del autor
                        try {
                            const authorId = firstComment.created_by?.id;
                            if (authorId) {
                                const author = await notion.users.retrieve({ user_id: authorId });
                                const enrichedComment = {
                                    ...firstComment,
                                    author: {
                                        id: author.id,
                                        name: author.name,
                                        avatar_url: author.avatar_url,
                                        type: author.type
                                    }
                                };
                                commentsMap.set(npsId, [enrichedComment]);

                                // Log del contenido del comentario extraído
                                console.log(`📝 [NPS ${npsId}] Comentario: "${firstCommentText.substring(0, 100)}..."`);
                            } else {
                                commentsMap.set(npsId, [firstComment]);
                            }
                        } catch (error) {
                            console.error('Error obteniendo información del autor:', error);
                            commentsMap.set(npsId, [firstComment]);
                        }
                    } else {
                        commentsMap.set(npsId, []);
                    }
                } catch (error) {
                    console.error(`Error obteniendo comentarios para ${npsId}:`, error);
                    commentsMap.set(npsId, []);
                }
            }
        }

        // Agrupar por cohorte
        const byCohort = new Map<string, {
            items: Array<{
                npsId: string;
                teacherScore: number;
                cohortScore: number;
                total: number;
                participation: number;
                tas: Array<{ id: string; name: string }>;
                taScores: number;
                cohortId: string;
                creationDate: string;
                visto: boolean;
                comments: any[];
            }>;
        }>();

        for (const page of pages) {
            const props = (page as any).properties || {};

            // Extraer datos de la página
            const npsId = props['NPS ID']?.title?.[0]?.plain_text || '';
            const cohortRelation = props['Cohorts']?.relation || [];
            const teacherScore = props['Teacher Score']?.number || 0;
            const cohortScore = props['Cohort Score']?.number || 0;
            const total = props['Total']?.number || 0;
            const participation = props['% Participation']?.formula?.number || 0;
            const visto = props['Visto']?.checkbox || false;
            const comments = commentsMap.get(npsId) || [];



            // Extraer fecha de creación real
            const creationDate = props['Date of Creation']?.date?.start ||
                props['Date of Creation']?.rich_text?.[0]?.plain_text ||
                page.created_time ||
                npsId; // Fallback al NPS ID si no hay fecha

            // Extraer TAs (puede ser rollup también)
            const taRelation = props['T.A.']?.relation || props['T.A.']?.rollup?.array || [];

            // Extraer TAs Scores - puede ser number o rich_text
            let taScores = 0;
            if (props['TA Score']?.formula?.number !== undefined) {
                taScores = props['TA Score']?.formula?.number;
            } else if (props['TAs Scores']?.rich_text?.[0]?.plain_text) {
                // Extraer número del texto "Beatriz Solana: 9.20"
                const taText = props['TAs Scores'].rich_text[0].plain_text;
                const scoreMatch = taText.match(/(\d+\.?\d*)/);
                if (scoreMatch) {
                    taScores = parseFloat(scoreMatch[1]);
                }
            }

            // Obtener nombres de TAs
            const tas = await Promise.all(
                taRelation.map(async (ta: any) => {
                    try {
                        // Si es un rollup, el objeto puede tener una estructura diferente
                        const taId = ta.id || ta.relation?.id;
                        if (!taId) {
                            // Intentar extraer nombre del texto de TAs Scores
                            if (props['TAs Scores']?.rich_text?.[0]?.plain_text) {
                                const taText = props['TAs Scores'].rich_text[0].plain_text;
                                const nameMatch = taText.match(/^([^:]+):/);
                                if (nameMatch) {
                                    return { id: 'unknown', name: nameMatch[1].trim() };
                                }
                            }
                            return { id: 'unknown', name: 'TA sin ID' };
                        }

                        const taPage = await notion.pages.retrieve({ page_id: taId });
                        const taName = (taPage as any).properties?.Name?.title?.[0]?.plain_text ||
                            (taPage as any).properties?.Title?.title?.[0]?.plain_text ||
                            'TA sin nombre';
                        return { id: taId, name: taName };
                    } catch (error) {
                        console.error(`Error obteniendo TA ${ta.id || ta.relation?.id}:`, error);
                        return { id: ta.id || ta.relation?.id || 'unknown', name: 'TA no encontrado' };
                    }
                })
            );

            // Agrupar por cohorte
            for (const cohort of cohortRelation) {
                const cohortId = cohort.id;
                if (!byCohort.has(cohortId)) {
                    byCohort.set(cohortId, { items: [] });
                }

                byCohort.get(cohortId)!.items.push({
                    npsId,
                    teacherScore,
                    cohortScore,
                    total,
                    participation,
                    tas,
                    taScores,
                    cohortId,
                    creationDate,
                    visto,
                    comments: commentsMap.get(npsId) || []

                });
            }
        }

        // Obtener información de cohortes
        const cohortIds = Array.from(byCohort.keys());
        const cohortPages = await Promise.all(
            cohortIds.map(async (id) => {
                try {
                    const page = await notion.pages.retrieve({ page_id: id });
                    return page;
                } catch (error) {
                    console.error(`Error obteniendo cohorte ${id}:`, error);
                    return null;
                }
            })
        );

        // Estados permitidos para mostrar NPS
        const allowedStatuses = ['Active', 'Final Project', 'Finished'];

        // Procesar resultados
        const resultActive: any[] = [];
        const resultPast: any[] = [];

        for (const cohortPage of cohortPages) {
            if (!cohortPage) continue;

            const cohortId = cohortPage.id;
            const cohortData = byCohort.get(cohortId);
            if (!cohortData) continue;

            const items = cohortData.items;

            // Obtener estado de la cohorte
            const status = (cohortPage as any).properties?.Status?.select?.name || '';

            // Solo procesar cohortes con estados permitidos
            if (!allowedStatuses.includes(status)) {
                continue;
            }

            // Calcular métricas - incluir todos los scores válidos (no solo > 0)
            const teacherScores = items.map(i => i.teacherScore).filter(s => s !== null && s !== undefined && s >= 0);
            const cohortScores = items.map(i => i.cohortScore).filter(s => s !== null && s !== undefined && s >= 0);
            const taScores = items.map(i => i.taScores).filter(s => s !== null && s !== undefined && s >= 0);
            const participations = items.map(i => i.participation).filter(p => p !== null && p !== undefined && p >= 0);

            const teacherMetrics = computeNps(teacherScores);
            const cohortMetrics = computeNps(cohortScores);
            const taMetrics = computeNps(taScores);

            // Obtener nombre de cohorte
            const cohortName = (cohortPage as any).properties?.Cohort?.title?.[0]?.plain_text ||
                (cohortPage as any).properties?.Title?.title?.[0]?.plain_text ||
                'Cohorte sin nombre';

            // Determinar si es activa o pasada
            const isActive = status === 'Active' || status === 'Final Project';
            const isPast = status === 'Finished';

            const payload = {
                cohortId,
                cohortName,
                status,
                metrics: {
                    teacher: teacherMetrics,
                    cohort: cohortMetrics,
                    tas: taMetrics,
                    participation: {
                        avg: participations.length > 0 ? Math.round((participations.reduce((a, b) => a + b, 0) / participations.length) * 10) / 10 : 0,
                        count: participations.length
                    }
                },
                items: items.map(item => ({
                    npsId: item.npsId,
                    teacherScore: item.teacherScore,
                    cohortScore: item.cohortScore,
                    total: item.total,
                    participation: item.participation,
                    tas: item.tas,
                    taScores: item.taScores,
                    visto: item.visto,
                    comments: commentsMap.get(item.npsId) || []
                })),
                totalEvaluations: items.length
            };

            if (isActive) {
                resultActive.push(payload);
            } else if (isPast && includePast) {
                resultPast.push(payload);
            }
        }

        // Métricas generales del mentor
        let allScores: number[];
        if (isAssistant) {
            // Para assistants, usar TA Score
            allScores = Array.from(byCohort.values())
                .flatMap(x => x.items.map(i => i.taScores))
                .filter(s => s !== null && s !== undefined && s >= 0);
        } else {
            // Para teachers, usar Teacher Score
            allScores = Array.from(byCohort.values())
                .flatMap(x => x.items.map(i => i.teacherScore))
                .filter(s => s !== null && s !== undefined && s >= 0);
        }

        const overall = computeNps(allScores);

        // Obtener nombre del mentor
        let mentorName = 'Mentor';
        try {
            const mentorPage = await notion.pages.retrieve({ page_id: mentorId });
            mentorName = (mentorPage as any).properties?.Name?.title?.[0]?.plain_text ||
                (mentorPage as any).properties?.Title?.title?.[0]?.plain_text ||
                'Mentor';
        } catch (error) {
            console.error('Error obteniendo nombre del mentor:', error);
        }

        // Organizar datos para visualización por cohorte
        const visualizationData = {
            // Datos organizados por cohorte con progresión individual
            cohorts: [...resultActive, ...resultPast].map(cohort => {
                const cohortData = byCohort.get(cohort.cohortId);
                if (!cohortData) return null;

                // Ordenar evaluaciones por fecha real de creación
                const sortedEvaluations = cohortData.items
                    .sort((a, b) => new Date(a.creationDate).getTime() - new Date(b.creationDate).getTime())
                    .map(item => ({
                        npsId: item.npsId,
                        date: item.creationDate, // Usar fecha real de creación
                        teacherScore: item.teacherScore,
                        cohortScore: item.cohortScore,
                        taScores: item.taScores,
                        participation: item.participation,
                        total: item.total,
                        tas: item.tas.map(ta => ta.name).join(', '),
                        comments: commentsMap.get(item.npsId) || []
                    }));

                return {
                    id: cohort.cohortId,
                    name: cohort.cohortName,
                    status: cohort.status,
                    isActive: resultActive.some(c => c.cohortId === cohort.cohortId),

                    // Métricas generales de la cohorte
                    metrics: {
                        teacher: {
                            average: cohort.metrics.teacher.avg,
                            nps: cohort.metrics.teacher.nps,
                            totalEvaluations: cohort.metrics.teacher.count
                        },
                        cohort: {
                            average: cohort.metrics.cohort.avg,
                            nps: cohort.metrics.cohort.nps,
                            totalEvaluations: cohort.metrics.cohort.count
                        },
                        tas: {
                            average: cohort.metrics.tas.avg,
                            nps: cohort.metrics.tas.nps,
                            totalEvaluations: cohort.metrics.tas.count
                        },
                        participation: {
                            average: cohort.metrics.participation.avg,
                            totalEvaluations: cohort.metrics.participation.count
                        }
                    },

                    // Progresión temporal individual de la cohorte
                    progression: {
                        teacher: sortedEvaluations.map(evaluation => ({
                            date: evaluation.date,
                            score: evaluation.teacherScore,
                            evaluationId: evaluation.npsId
                        })),
                        cohort: sortedEvaluations.map(evaluation => ({
                            date: evaluation.date,
                            score: evaluation.cohortScore,
                            evaluationId: evaluation.npsId
                        })),
                        tas: sortedEvaluations.map(evaluation => ({
                            date: evaluation.date,
                            score: evaluation.taScores,
                            evaluationId: evaluation.npsId
                        })),
                        participation: sortedEvaluations.map(evaluation => ({
                            date: evaluation.date,
                            participation: evaluation.participation,
                            evaluationId: evaluation.npsId
                        }))
                    },

                    // Evaluaciones detalladas
                    evaluations: sortedEvaluations.map(evaluation => ({
                        ...evaluation,
                        visto: cohortData.items.find(item => item.npsId === evaluation.npsId)?.visto || false,
                        comments: commentsMap.get(evaluation.npsId) || []
                    })),
                    totalEvaluations: cohort.totalEvaluations
                };
            }).filter(Boolean), // Filtrar nulls

            // Datos para gráficos comparativos
            charts: {
                // Promedios por cohorte (barras)
                averagesByCohort: [...resultActive, ...resultPast].map(cohort => ({
                    name: cohort.cohortName,
                    teacherAverage: cohort.metrics.teacher.avg,
                    cohortAverage: cohort.metrics.cohort.avg,
                    taAverage: cohort.metrics.tas.avg, // Agregar promedio de TA
                    status: cohort.status,
                    isActive: resultActive.some(c => c.cohortId === cohort.cohortId)
                })),

                // Participación por cohorte
                participationByCohort: [...resultActive, ...resultPast].map(cohort => ({
                    name: cohort.cohortName,
                    participation: cohort.metrics.participation.avg,
                    evaluations: cohort.totalEvaluations,
                    status: cohort.status
                }))
            },

            // Datos para tablas
            tables: {
                // Tabla de cohortes
                cohorts: [...resultActive, ...resultPast].map(cohort => ({
                    id: cohort.cohortId,
                    name: cohort.cohortName,
                    status: cohort.status,
                    teacherAverage: cohort.metrics.teacher.avg,
                    cohortAverage: cohort.metrics.cohort.avg,
                    taAverage: cohort.metrics.tas.avg, // Agregar promedio de TA
                    participation: cohort.metrics.participation.avg,
                    evaluations: cohort.totalEvaluations,
                    isActive: resultActive.some(c => c.cohortId === cohort.cohortId)
                })),

                // Tabla de evaluaciones recientes (últimas 10 de todas las cohortes)
                recentEvaluations: Array.from(byCohort.values())
                    .flatMap(x => x.items)
                    .sort((a, b) => new Date(b.creationDate).getTime() - new Date(a.creationDate).getTime())
                    .slice(0, 10)
                    .map(item => {
                        const cohortPage = cohortPages.find(c => c?.id === item.cohortId);
                        const cohortName = cohortPage ?
                            (cohortPage as any).properties?.Cohort?.title?.[0]?.plain_text ||
                            (cohortPage as any).properties?.Name?.title?.[0]?.plain_text ||
                            (cohortPage as any).properties?.Title?.title?.[0]?.plain_text ||
                            'Cohorte' : 'Cohorte';
                        return {
                            npsId: item.npsId,
                            cohortName,
                            date: item.creationDate, // Añadir fecha de creación del NPS
                            teacherScore: item.teacherScore,
                            cohortScore: item.cohortScore,
                            total: item.total,
                            participation: item.participation,
                            taScores: item.taScores,
                            tas: item.tas.map(ta => ta.name).join(', '),
                            visto: item.visto,
                            comments: commentsMap.get(item.npsId) || []
                        };
                    })
            },

            // Datos para KPIs
            kpis: {
                overallTeacherAverage: overall.avg, // Ahora puede ser TA o Teacher según el rol
                overallCohortAverage: Array.from(byCohort.values())
                    .flatMap(x => x.items.map(i => i.cohortScore))
                    .filter(s => s > 0)
                    .reduce((a, b) => a + b, 0) /
                    Array.from(byCohort.values())
                        .flatMap(x => x.items.map(i => i.cohortScore))
                        .filter(s => s > 0).length || 0,
                overallTAAverage: Array.from(byCohort.values()) // Agregar promedio general de TA
                    .flatMap(x => x.items.map(i => i.taScores))
                    .filter(s => s > 0)
                    .reduce((a, b) => a + b, 0) /
                    Array.from(byCohort.values())
                        .flatMap(x => x.items.map(i => i.taScores))
                        .filter(s => s > 0).length || 0,
                totalEvaluations: pages.length,
                totalCohorts: resultActive.length + resultPast.length,
                activeCohorts: resultActive.length,
                finishedCohorts: resultPast.length,
                averageParticipation: Array.from(byCohort.values())
                    .flatMap(x => x.items.map(i => i.participation))
                    .filter(p => p > 0)
                    .reduce((a, b) => a + b, 0) /
                    Array.from(byCohort.values())
                        .flatMap(x => x.items.map(i => i.participation))
                        .filter(p => p > 0).length || 0,
                scoreType: isAssistant ? 'TA Score' : 'Teacher Score' // Añadir tipo de score
            },

            // Metadatos
            metadata: {
                mentorId,
                mentorName,
                lastUpdated: new Date().toISOString(),
                dataPoints: {
                    totalEvaluations: pages.length,
                    totalCohorts: resultActive.length + resultPast.length,
                    activeCohorts: resultActive.length,
                    pastCohorts: resultPast.length
                }
            }
        };

        // Asegurar que visualizationData siempre tenga una estructura válida
        const safeVisualizationData = {
            cohorts: visualizationData.cohorts || [],
            charts: {
                averagesByCohort: visualizationData.charts?.averagesByCohort || [],
                participationByCohort: visualizationData.charts?.participationByCohort || []
            },
            tables: {
                cohorts: visualizationData.tables?.cohorts || [],
                recentEvaluations: visualizationData.tables?.recentEvaluations || []
            },
            kpis: {
                overallTeacherAverage: visualizationData.kpis?.overallTeacherAverage || 0,
                overallCohortAverage: visualizationData.kpis?.overallCohortAverage || 0,
                overallTAAverage: visualizationData.kpis?.overallTAAverage || 0,
                totalEvaluations: visualizationData.kpis?.totalEvaluations || 0,
                totalCohorts: visualizationData.kpis?.totalCohorts || 0,
                activeCohorts: visualizationData.kpis?.activeCohorts || 0,
                finishedCohorts: visualizationData.kpis?.finishedCohorts || 0,
                averageParticipation: visualizationData.kpis?.averageParticipation || 0
            },
            metadata: {
                mentorId,
                mentorName,
                lastUpdated: new Date().toISOString(),
                dataPoints: {
                    totalEvaluations: pages.length,
                    totalCohorts: resultActive.length + resultPast.length,
                    activeCohorts: resultActive.length,
                    pastCohorts: resultPast.length
                }
            }
        };

        res.status(200).json({
            activeCohorts: resultActive,
            pastCohorts: resultPast,
            overall: {
                teacherAverage: overall.avg, // Mantener nombre por compatibilidad
                totalEvaluations: overall.count,
                scoreType: isAssistant ? 'TA Score' : 'Teacher Score' // Añadir información del tipo
            },
            totalCohorts: resultActive.length + resultPast.length,
            totalEvaluations: pages.length,
            mentorId,
            mentorName,
            userRole: isAssistant ? 'assistant' : 'teacher', // Añadir rol del usuario
            visualizationData: safeVisualizationData,
            totalComments: Array.from(commentsMap.values()).flat().length
        });

    } catch (err: any) {
        console.error('Error obteniendo NPS del mentor:', err);
        res.status(500).json({ error: 'Error al obtener NPS del mentor', details: err?.message });
    }
});

// Endpoint para actualizar el estado "Visto" de una evaluación NPS
app.put('/api/mentor-nps/evaluation-seen', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const { evaluationId, seen } = req.body;

        // Validar parámetros requeridos
        if (!evaluationId) {
            return res.status(400).json({ error: 'Se requiere evaluationId (NPS ID)' });
        }

        if (typeof seen !== 'boolean') {
            return res.status(400).json({ error: 'El campo seen debe ser un booleano' });
        }

        // Verificar que la evaluación pertenece al mentor autenticado
        const NPS_DB = process.env.NOTION_NPS_DATABASE_ID || '';
        if (!NPS_DB) {
            return res.status(500).json({ error: 'Falta NOTION_NPS_DATABASE_ID en variables de entorno' });
        }

        // Obtener el mentorId del usuario autenticado
        let mentorId: string;
        try {
            mentorId = await resolveMentorIdFromReq(req);
        } catch (error: any) {
            return res.status(400).json({ error: error.message });
        }

        // Buscar la evaluación por NPS ID (título)
        const evaluationQuery = await notion.databases.query({
            database_id: NPS_DB,
            filter: {
                property: 'NPS ID',
                title: {
                    equals: evaluationId.toString()
                }
            }
        });

        if (!evaluationQuery.results || evaluationQuery.results.length === 0) {
            return res.status(404).json({ error: 'Evaluación NPS no encontrada con ese NPS ID' });
        }

        const evaluation = evaluationQuery.results[0] as any;
        const notionPageId = evaluation.id;


        // Actualizar la propiedad "Visto"
        const updateResponse = await notion.pages.update({
            page_id: notionPageId,
            properties: {
                'Visto': {
                    checkbox: seen
                }
            }
        });

        if (!updateResponse) {
            return res.status(500).json({ error: 'Error al actualizar la evaluación' });
        }

        res.status(200).json({
            message: 'Estado de evaluación actualizado correctamente',
            npsId: evaluationId,
            notionPageId: notionPageId,
            seen,
            updatedAt: new Date().toISOString()
        });

    } catch (error: any) {
        console.error('Error actualizando estado de evaluación NPS:', error);

        // Manejar errores específicos de Notion
        if (error.code === 'validation_error') {
            return res.status(400).json({
                error: 'Error de validación en Notion',
                details: error.message
            });
        }

        if (error.code === 'object_not_found') {
            return res.status(404).json({
                error: 'Evaluación NPS no encontrada'
            });
        }

        res.status(500).json({
            error: 'Error al actualizar el estado de la evaluación',
            details: error.message
        });
    }
});

app.get('/api/mentors/me', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const email = (req as any).user4GeeksData?.email;
        if (!email) return res.status(400).json({ error: 'No se encontró email en el token' });

        const MENTORS_DB = process.env.NOTION_MENTORS_DATABASE_ID || '';
        if (!MENTORS_DB) return res.status(500).json({ error: 'Falta NOTION_MENTORS_DATABASE_ID' });

        const result = await notion.databases.query({
            database_id: MENTORS_DB,
            filter: { property: 'Correo', email: { equals: email } }
        });

        if (!result.results?.length) return res.status(404).json({ error: 'Mentor no encontrado' });

        const page = result.results[0] as any;
        const name =
            page.properties?.Name?.title?.[0]?.plain_text ||
            page.properties?.Title?.title?.[0]?.plain_text ||
            [(req as any).user4GeeksData?.first_name, (req as any).user4GeeksData?.last_name]
                .filter(Boolean)
                .join(' ') ||
            (req as any).user4GeeksData?.username;

        res.status(200).json({
            id: page.id,
            name: name?.trim() || null,
            email
        });
    } catch (err) {
        console.error('Error consultando mentor:', err);
        res.status(500).json({ error: 'Error al consultar mentor' });
    }
});

function isISODateString(dateStr: string) {
    // Verifica si el string es un ISO 8601 válido (YYYY-MM-DDTHH:mm o similar)
    return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dateStr);
}

app.listen(5000, () => console.log('Server ready on port 5000.'));

export default app;
