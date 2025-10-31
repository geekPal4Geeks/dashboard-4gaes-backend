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

// Helper para validar datos de cambio de mentor
function validateMentorChangeData(
    teacherIds: string[],
    mentorChangeDate: string | null,
    evaluationDate: string
): { isValid: boolean; warnings: string[]; reason?: string } {
    const warnings: string[] = [];

    // Validar que si hay fecha de cambio, debe haber exactamente 2 mentores
    if (mentorChangeDate && teacherIds.length !== 2) {
        warnings.push(`Fecha de cambio presente (${mentorChangeDate}) pero hay ${teacherIds.length} mentores en lugar de 2`);
        return { isValid: false, warnings, reason: 'Inconsistencia en datos de cambio de mentor' };
    }

    // Validar que si hay 2 mentores, debe haber fecha de cambio
    if (teacherIds.length === 2 && !mentorChangeDate) {
        warnings.push('2 mentores detectados pero sin fecha de cambio');
        return { isValid: false, warnings, reason: 'Falta fecha de cambio para múltiples mentores' };
    }

    // Validar que si hay 1 mentor, no debe haber fecha de cambio
    if (teacherIds.length === 1 && mentorChangeDate) {
        warnings.push(`1 mentor pero con fecha de cambio (${mentorChangeDate})`);
        return { isValid: false, warnings, reason: 'Fecha de cambio innecesaria para un solo mentor' };
    }

    return { isValid: true, warnings };
}

// Helper para determinar si un mentor es responsable de una evaluación específica
function isMentorResponsibleForEvaluation(
    evaluationDate: string,
    mentorChangeDate: string | null,
    teacherIds: string[],
    currentMentorId: string
): { isResponsible: boolean; reason: string; originalMentorId?: string; newMentorId?: string } {
    // Normalizar todos los IDs removiendo guiones para comparar correctamente
    const normalizedTeacherIds = teacherIds.map(id => id.replace(/-/g, ''));
    const normalizedCurrentMentorId = currentMentorId.replace(/-/g, '');

    // Caso 1: Sin cambio de mentor (1 mentor o sin fecha de cambio)
    if (!mentorChangeDate || normalizedTeacherIds.length === 1) {
        const isResponsible = normalizedTeacherIds.includes(normalizedCurrentMentorId);
        return {
            isResponsible,
            reason: isResponsible ? 'Mentor único - responsable de todas las evaluaciones' : 'Mentor único - no es el mentor asignado'
        };
    }

    // Caso 2: Con cambio de mentor (2 mentores + fecha de cambio)
    if (normalizedTeacherIds.length === 2) {
        const originalMentorId = normalizedTeacherIds[0]; // Primer mentor (original)
        const newMentorId = normalizedTeacherIds[1];      // Segundo mentor (nuevo)

        const evaluationTime = new Date(evaluationDate).getTime();
        const changeTime = new Date(mentorChangeDate).getTime();

        // Evaluación ANTES del cambio → Original mentor es responsable
        if (evaluationTime < changeTime) {
            const isOriginalMentor = normalizedCurrentMentorId === originalMentorId;
            return {
                isResponsible: isOriginalMentor,
                reason: isOriginalMentor ?
                    'Evaluación antes del cambio - mentor original responsable' :
                    'Evaluación antes del cambio - mentor nuevo no responsable',
                originalMentorId: teacherIds[0], // Mantener formato original con guiones para respuesta
                newMentorId: teacherIds[1]       // Mantener formato original con guiones para respuesta
            };
        }

        // Evaluación DESPUÉS del cambio → Nuevo mentor es responsable
        const isNewMentor = normalizedCurrentMentorId === newMentorId;
        return {
            isResponsible: isNewMentor,
            reason: isNewMentor ?
                'Evaluación después del cambio - mentor nuevo responsable' :
                'Evaluación después del cambio - mentor original no responsable',
            originalMentorId: teacherIds[0], // Mantener formato original con guiones para respuesta
            newMentorId: teacherIds[1]       // Mantener formato original con guiones para respuesta
        };
    }

    // Caso 3: Datos inconsistentes
    return {
        isResponsible: false,
        reason: 'Datos inconsistentes - no se puede determinar responsabilidad'
    };
}

async function resolveMentorIdFromReq(req: Request): Promise<string> {
    const email = (req as any).user4GeeksData?.email;
    if (!email) {
        console.error('❌ [resolveMentorIdFromReq] No se encontró email en el token');
        throw new Error('No se encontró email en el token');
    }

    const MENTORS_DB = process.env.NOTION_MENTORS_DATABASE_ID || '';
    if (!MENTORS_DB) {
        console.error('❌ [resolveMentorIdFromReq] Falta NOTION_MENTORS_DATABASE_ID en variables de entorno');
        throw new Error('Falta NOTION_MENTORS_DATABASE_ID');
    }

    console.log('🔍 [resolveMentorIdFromReq] Buscando mentor con email:', email);
    console.log('🔍 [resolveMentorIdFromReq] Usando base de datos:', MENTORS_DB);

    try {
        const result = await notion.databases.query({
            database_id: MENTORS_DB,
            filter: { property: 'Correo', email: { equals: email } }
        });

        console.log('📊 [resolveMentorIdFromReq] Resultado de la consulta:', {
            totalResults: result.results?.length || 0,
            hasResults: !!result.results?.length,
            email: email
        });

        if (!result.results?.length) {
            console.error('❌ [resolveMentorIdFromReq] Mentor no encontrado para email:', email);
            console.error('❌ [resolveMentorIdFromReq] Posibles causas:');
            console.error('   - El email no existe en la base de datos de mentores');
            console.error('   - El nombre de la propiedad "Correo" es incorrecto');
            console.error('   - El formato del email no coincide exactamente');
            console.error('   - El mentor no está registrado en Notion');
            throw new Error(`Mentor no encontrado para el email: ${email}`);
        }

        const mentorId = result.results[0].id;
        console.log('✅ [resolveMentorIdFromReq] Mentor encontrado:', {
            mentorId,
            email,
            mentorName: (result.results[0] as any).properties?.Name?.title?.[0]?.plain_text || 'Sin nombre'
        });

        return mentorId;
    } catch (error: any) {
        console.error('❌ [resolveMentorIdFromReq] Error en la consulta a Notion:', {
            error: error.message,
            email,
            databaseId: MENTORS_DB,
            errorCode: error.code,
            errorType: error.type
        });
        
        // Re-lanzar el error con más contexto
        throw new Error(`Error consultando mentor en Notion: ${error.message}`);
    }
}

// Endpoint para obtener NPS de un mentor
app.post('/api/mentor-nps', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        console.log('🔍 [mentor-nps] Iniciando consulta NPS');
        console.log('🔍 [mentor-nps] Datos del usuario:', {
            email: (req as any).user4GeeksData?.email,
            roles: (req as any).user4GeeksData?.roles || []
        });

        const { mentorId: mentorIdFromBody, startDate, endDate, includePast = true } = req.body;

        let mentorId: string | undefined = undefined;
        
        // Procesar mentorIdFromBody si existe
        if (mentorIdFromBody !== undefined && mentorIdFromBody !== null) {
            // Convertir a string y validar formato básico
            if (typeof mentorIdFromBody === 'string') {
                mentorId = mentorIdFromBody.trim();
                console.log('✅ [mentor-nps] MentorId recibido del body:', mentorId);
            } else if (typeof mentorIdFromBody === 'number') {
                mentorId = mentorIdFromBody.toString();
                console.log('⚠️ [mentor-nps] MentorId convertido de número a string:', mentorId);
            } else {
                console.error('❌ [mentor-nps] Tipo de mentorId inválido:', {
                    type: typeof mentorIdFromBody,
                    value: mentorIdFromBody
                });
                return res.status(400).json({ 
                    error: 'Tipo de mentorId inválido',
                    details: 'El mentorId debe ser un string o número',
                    received: {
                        type: typeof mentorIdFromBody,
                        value: mentorIdFromBody
                    }
                });
            }
        }
        
        // Si no se proporciona mentorId en el body, intentar resolverlo desde el token
        if (!mentorId) {
            console.log('🔍 [mentor-nps] No se proporcionó mentorId en el body, resolviendo desde token...');
            try {
                mentorId = await resolveMentorIdFromReq(req);
                console.log('✅ [mentor-nps] MentorId resuelto exitosamente:', mentorId);
            } catch (error: any) {
                console.error('❌ [mentor-nps] Error resolviendo mentorId:', {
                    error: error.message,
                    email: (req as any).user4GeeksData?.email,
                    stack: error.stack
                });
                return res.status(400).json({ 
                    error: 'Error resolviendo mentorId', 
                    details: error.message,
                    troubleshooting: {
                        checkEmail: 'Verifica que el email del usuario esté registrado en la base de datos de mentores',
                        checkNotion: 'Verifica que el mentor esté registrado en Notion con el email correcto',
                        checkProperty: 'Verifica que la propiedad se llame "Correo" en la base de datos de mentores',
                        useDebugEndpoint: 'Usa POST /api/mentors/debug para obtener más información'
                    }
                });
            }
        } else {
            console.log('✅ [mentor-nps] Usando mentorId proporcionado en el body:', mentorId);
        }

        // Validar que mentorId tenga el formato correcto (UUID de Notion)
        if (!mentorId) {
            console.error('❌ [mentor-nps] MentorId faltante');
            return res.status(400).json({ 
                error: 'MentorId faltante',
                details: 'No se pudo obtener el mentorId ni del body ni del token'
            });
        }

        // Validar formato UUID de Notion (acepta tanto formato con guiones como sin guiones)
        const uuidWithDashesRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        const uuidWithoutDashesRegex = /^[a-f0-9]{32}$/i;
        
        if (!uuidWithDashesRegex.test(mentorId) && !uuidWithoutDashesRegex.test(mentorId)) {
            console.error('❌ [mentor-nps] MentorId con formato inválido:', {
                mentorId,
                length: mentorId.length,
                isValidWithDashes: uuidWithDashesRegex.test(mentorId),
                isValidWithoutDashes: uuidWithoutDashesRegex.test(mentorId)
            });
            return res.status(400).json({ 
                error: 'Formato de MentorId inválido',
                details: 'El mentorId debe ser un UUID válido de Notion',
                received: {
                    value: mentorId,
                    length: mentorId.length,
                    expectedFormats: [
                        'Con guiones: 230463fd-128a-4188-82d3-ca5445bc19c4 (36 caracteres)',
                        'Sin guiones: 230463fd128a418882d3ca5445bc19c4 (32 caracteres)'
                    ]
                }
            });
        }

        // Guardar el mentorId original (con guiones) para usar en filtros de Notion
        const originalMentorId = mentorId;
        // Normalizar UUID removiendo guiones para comparaciones en código
        const normalizedMentorId = mentorId.replace(/-/g, '');
        console.log('✅ [mentor-nps] MentorId procesado:', {
            original: originalMentorId,
            normalized: normalizedMentorId,
            length: normalizedMentorId.length
        });

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
        // Nota: Notion espera IDs con guiones en los filtros de relaciones
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
                                    contains: originalMentorId
                                }
                            }
                        }
                    }
                ]
            };
            console.log('🔍 [mentor-nps] Filtro para Assistant:', JSON.stringify(filter, null, 2));
        } else {
            // Para teachers, usar la propiedad Teacher (comportamiento actual)
            filter = {
                and: [
                    {
                        property: 'Teacher',
                        rollup: {
                            any: {
                                relation: {
                                    contains: originalMentorId
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



        // Obtener todas las páginas de NPS del mentor (incluyendo las que no le corresponden)
        let allPages: any[];
        try {
            console.log('🔍 [mentor-nps] Ejecutando consulta a Notion:', {
                databaseId: NPS_DB,
                filter: JSON.stringify(filter, null, 2),
                mentorId: originalMentorId,
                normalizedMentorId,
                userRole: isAssistant ? 'assistant' : 'teacher'
            });
            
            allPages = await notionQueryAll(NPS_DB, filter);
            
            console.log('📊 [mentor-nps] Resultado de consulta Notion:', {
                totalPages: allPages.length,
                mentorId: originalMentorId,
                normalizedMentorId,
                userRole: isAssistant ? 'assistant' : 'teacher'
            });
            
            if (allPages.length === 0) {
                console.log('⚠️ [mentor-nps] No se encontraron evaluaciones NPS para este mentor');
            }
        } catch (error) {
            console.error('❌ [mentor-nps] Error consultando Notion:', {
                error: error.message,
                databaseId: NPS_DB,
                filter: JSON.stringify(filter, null, 2),
                mentorId: originalMentorId,
                normalizedMentorId
            });
            return res.status(500).json({
                error: 'Error consultando Notion',
                details: error.message,
                databaseId: NPS_DB
            });
        }

        // Filtrar evaluaciones que realmente corresponden al mentor actual
        const pages: any[] = [];
        const skippedEvaluations: any[] = [];

        for (const page of allPages) {
            const props = (page as any).properties || {};

            // Para assistants, no aplicar lógica de cambio de mentor (pueden haber múltiples TAs)
            if (isAssistant) {
                // Verificar que el TA actual esté en la lista de TAs de la evaluación
                const taRelation = props['T.A.']?.relation || props['T.A.']?.rollup?.array?.[0]?.relation || [];
                const taIds = taRelation.map((t: any) => t.id);
                // Normalizar los IDs removiendo guiones para comparar correctamente
                const normalizedTaIds = taIds.map((id: string) => id.replace(/-/g, ''));

                console.log('🔍 [mentor-nps] Procesando evaluación para assistant:', {
                    npsId: props['NPS ID']?.title?.[0]?.plain_text || 'sin ID',
                    originalMentorId,
                    normalizedMentorId,
                    taProperty: props['T.A.'],
                    taRelation,
                    taIds,
                    normalizedTaIds,
                    mentorIdIncluded: normalizedTaIds.includes(normalizedMentorId)
                });

                if (normalizedTaIds.includes(normalizedMentorId)) {
                    pages.push(page);
                } else {
                    skippedEvaluations.push({
                        npsId: props['NPS ID']?.title?.[0]?.plain_text || 'sin ID',
                        reason: 'TA no presente en la evaluación',
                        evaluationDate: props['Date of Creation']?.date?.start || page.created_time,
                        mentorChangeDate: null,
                        teacherIds: taIds
                    });
                }
            } else {
                // Para teachers, aplicar lógica de cambio de mentor (1 mentor por cohorte)
                const teacherRelation = props['Teacher']?.relation || props['Teacher']?.rollup?.array?.[0]?.relation || [];
                const teacherIds = teacherRelation.map((t: any) => t.id);
                const mentorChangeDate = props['Mentor Change Date']?.rollup?.array?.[0]?.date?.start || null;

                // Extraer fecha de evaluación
                const evaluationDate = props['Date of Creation']?.date?.start ||
                    props['Date of Creation']?.rich_text?.[0]?.plain_text ||
                    page.created_time ||
                    props['NPS ID']?.title?.[0]?.plain_text || '';

                // Determinar si el mentor actual es responsable de esta evaluación
                // Usar el mentorId normalizado para comparaciones
                const responsibility = isMentorResponsibleForEvaluation(
                    evaluationDate,
                    mentorChangeDate,
                    teacherIds,
                    normalizedMentorId
                );

                if (responsibility.isResponsible) {
                    pages.push(page);
                } else {
                    skippedEvaluations.push({
                        npsId: props['NPS ID']?.title?.[0]?.plain_text || 'sin ID',
                        reason: responsibility.reason,
                        evaluationDate,
                        mentorChangeDate,
                        teacherIds
                    });
                }
            }
        }


        // Obtener comentarios solo para las evaluaciones asignadas
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
                            } else {
                                commentsMap.set(npsId, [firstComment]);
                            }
                        } catch (error) {
                            commentsMap.set(npsId, [firstComment]);
                        }
                    } else {
                        commentsMap.set(npsId, []);
                    }
                } catch (error) {
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

        // Variables para tracking de validación
        const validationStats = {
            totalEvaluations: allPages.length,
            assignedEvaluations: pages.length,
            skippedEvaluations: skippedEvaluations.length,
            warnings: [] as string[],
            mentorChanges: {
                total: 0,
                withChangeDate: 0,
                withoutChangeDate: 0
            }
        };

        // Procesar solo las evaluaciones asignadas al mentor
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

            // Extraer datos de cambio de mentor para validación
            const teacherRelation = props['Teacher']?.relation || props['Teacher']?.rollup?.array?.[0]?.relation || [];
            const teacherIds = teacherRelation.map((t: any) => t.id);
            const mentorChangeDate = props['Mentor Change Date']?.rollup?.array?.[0]?.date?.start || null;

            // Extraer fecha de evaluación
            const evaluationDate = props['Date of Creation']?.date?.start ||
                props['Date of Creation']?.rich_text?.[0]?.plain_text ||
                page.created_time ||
                npsId;

            // Para assistants, no aplicar validaciones de cambio de mentor
            if (!isAssistant) {
                // Validar datos de cambio de mentor (solo para teachers)
                const validation = validateMentorChangeData(teacherIds, mentorChangeDate, evaluationDate);
                if (!validation.isValid) {
                    validationStats.warnings.push(`Evaluación ${npsId}: ${validation.reason}`);
                }

                // Actualizar estadísticas de cambio de mentor
                if (teacherIds.length === 2) {
                    validationStats.mentorChanges.total++;
                    if (mentorChangeDate) {
                        validationStats.mentorChanges.withChangeDate++;
                    } else {
                        validationStats.mentorChanges.withoutChangeDate++;
                    }
                }
            }



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
            // Silently handle error getting mentor name
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
                mentorId: originalMentorId,
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
                mentorId: originalMentorId,
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
            totalEvaluations: validationStats.assignedEvaluations,
            mentorId: originalMentorId,
            mentorName,
            userRole: isAssistant ? 'assistant' : 'teacher', // Añadir rol del usuario
            visualizationData: safeVisualizationData,
            totalComments: Array.from(commentsMap.values()).flat().length,
            // NUEVO: Estadísticas de validación de cambio de mentor
            mentorChangeValidation: {
                totalEvaluationsFound: validationStats.totalEvaluations,
                evaluationsAssigned: validationStats.assignedEvaluations,
                evaluationsSkipped: validationStats.skippedEvaluations,
                warnings: validationStats.warnings,
                mentorChanges: validationStats.mentorChanges,
                skippedEvaluationsDetails: skippedEvaluations.map(skip => ({
                    npsId: skip.npsId,
                    reason: skip.reason,
                    evaluationDate: skip.evaluationDate,
                    mentorChangeDate: skip.mentorChangeDate,
                    teacherIds: skip.teacherIds
                })),
                summary: {
                    hasMentorChanges: validationStats.mentorChanges.total > 0,
                    hasWarnings: validationStats.warnings.length > 0,
                    assignmentAccuracy: validationStats.totalEvaluations > 0 ?
                        Math.round((validationStats.assignedEvaluations / validationStats.totalEvaluations) * 100) : 0
                }
            }
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



// Endpoint de prueba para diagnosticar assistants sin autenticación
app.post('/api/mentors/test-assistant', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ 
                error: 'Se requiere email',
                example: { email: 'torres_rominav@hotmail.com' }
            });
        }

        console.log('🔍 [test-assistant] Iniciando prueba para:', email);

        const MENTORS_DB = process.env.NOTION_MENTORS_DATABASE_ID || '';
        const NPS_DB = process.env.NOTION_NPS_DATABASE_ID || '';

        if (!MENTORS_DB || !NPS_DB) {
            return res.status(500).json({ 
                error: 'Variables de entorno faltantes',
                mentorsDb: !!MENTORS_DB,
                npsDb: !!NPS_DB
            });
        }

        // Paso 1: Buscar el mentor en la base de datos de mentores
        console.log('🔍 [test-assistant] Paso 1: Buscando mentor en base de datos de mentores');
        const mentorQuery = await notion.databases.query({
            database_id: MENTORS_DB,
            filter: { property: 'Correo', email: { equals: email } }
        });

        if (!mentorQuery.results?.length) {
            return res.status(404).json({ 
                error: 'Mentor no encontrado',
                email,
                databaseId: MENTORS_DB
            });
        }

        const mentor = mentorQuery.results[0] as any;
        const mentorId = mentor.id;
        const mentorName = mentor.properties?.Name?.title?.[0]?.plain_text || 'Sin nombre';

        console.log('✅ [test-assistant] Mentor encontrado:', {
            mentorId,
            mentorName,
            email
        });

        // Paso 2: Probar diferentes filtros en la base de datos NPS
        console.log('🔍 [test-assistant] Paso 2: Probando filtros en base de datos NPS');
        
        const filterTests = [
            {
                name: 'Filtro T.A. con rollup (actual)',
                filter: {
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
                }
            },
            {
                name: 'Filtro T.A. directo (sin rollup)',
                filter: {
                    property: 'T.A.',
                    relation: {
                        contains: mentorId
                    }
                }
            },
            {
                name: 'Filtro T.A. con contains directo',
                filter: {
                    property: 'T.A.',
                    contains: mentorId
                }
            },
            {
                name: 'Filtro Teacher (para comparar)',
                filter: {
                    property: 'Teacher',
                    rollup: {
                        any: {
                            relation: {
                                contains: mentorId
                            }
                        }
                    }
                }
            }
        ];

        const results = [];

        for (const test of filterTests) {
            try {
                console.log(`🔍 [test-assistant] Probando: ${test.name}`);
                
                const queryResult = await notion.databases.query({
                    database_id: NPS_DB,
                    filter: test.filter as any
                });

                results.push({
                    filterName: test.name,
                    totalResults: queryResult.results?.length || 0,
                    success: true,
                    error: null,
                    sampleResults: queryResult.results?.slice(0, 3).map((page: any) => ({
                        id: page.id,
                        npsId: page.properties?.['NPS ID']?.title?.[0]?.plain_text || 'Sin ID',
                        taRelation: page.properties?.['T.A.']?.relation || page.properties?.['T.A.']?.rollup || 'Sin relación',
                        teacherRelation: page.properties?.['Teacher']?.relation || page.properties?.['Teacher']?.rollup || 'Sin relación',
                        cohortRelation: page.properties?.['Cohorts']?.relation || 'Sin relación'
                    })) || []
                });

                console.log(`✅ [test-assistant] ${test.name}: ${queryResult.results?.length || 0} resultados`);
            } catch (error: any) {
                results.push({
                    filterName: test.name,
                    totalResults: 0,
                    success: false,
                    error: error.message,
                    sampleResults: []
                });
                console.log(`❌ [test-assistant] ${test.name}: Error - ${error.message}`);
            }
        }

        // Paso 3: Obtener información de la estructura de la base de datos
        console.log('🔍 [test-assistant] Paso 3: Analizando estructura de base de datos');
        let databaseInfo = null;
        try {
            const dbInfo = await notion.databases.retrieve({ database_id: NPS_DB });
            databaseInfo = {
                id: dbInfo.id,
                title: (dbInfo as any).title?.[0]?.plain_text || 'Sin título',
                properties: Object.keys((dbInfo as any).properties || {}),
                taPropertyExists: !!(dbInfo as any).properties?.['T.A.'],
                taPropertyType: (dbInfo as any).properties?.['T.A.']?.type || 'No encontrado',
                teacherPropertyExists: !!(dbInfo as any).properties?.['Teacher'],
                teacherPropertyType: (dbInfo as any).properties?.['Teacher']?.type || 'No encontrado'
            };
        } catch (error: any) {
            databaseInfo = { error: error.message };
        }

        // Paso 4: Buscar todas las evaluaciones para ver si hay alguna con este TA
        console.log('🔍 [test-assistant] Paso 4: Buscando todas las evaluaciones para encontrar referencias');
        let allEvaluations = [];
        try {
            const allQuery = await notion.databases.query({
                database_id: NPS_DB,
                page_size: 100 // Limitar para no sobrecargar
            });
            
            allEvaluations = allQuery.results?.slice(0, 10).map((page: any) => ({
                id: page.id,
                npsId: page.properties?.['NPS ID']?.title?.[0]?.plain_text || 'Sin ID',
                taRelation: page.properties?.['T.A.']?.relation || page.properties?.['T.A.']?.rollup || 'Sin relación',
                teacherRelation: page.properties?.['Teacher']?.relation || page.properties?.['Teacher']?.rollup || 'Sin relación',
                hasOurMentorId: JSON.stringify(page.properties).includes(mentorId)
            })) || [];
        } catch (error: any) {
            console.log('⚠️ [test-assistant] Error obteniendo todas las evaluaciones:', error.message);
        }

        const diagnosis = {
            testInfo: {
                email,
                mentorId,
                mentorName,
                timestamp: new Date().toISOString()
            },
            databaseInfo,
            filterTests: results,
            allEvaluationsSample: allEvaluations,
            recommendations: []
        };

        // Generar recomendaciones
        const successfulFilters = results.filter(r => r.success && r.totalResults > 0);
        const failedFilters = results.filter(r => !r.success);

        if (successfulFilters.length === 0) {
            diagnosis.recommendations.push('❌ Ningún filtro encontró evaluaciones - el assistant no está asociado a evaluaciones NPS');
            diagnosis.recommendations.push('💡 Verificar en Notion que las evaluaciones NPS tengan este assistant en la propiedad T.A.');
        } else {
            diagnosis.recommendations.push(`✅ Usar el filtro "${successfulFilters[0].filterName}" que encontró ${successfulFilters[0].totalResults} evaluaciones`);
        }

        if (failedFilters.length > 0) {
            diagnosis.recommendations.push('⚠️ Algunos filtros fallaron - verificar la estructura de la base de datos NPS');
        }

        if (allEvaluations.length > 0) {
            const hasReferences = allEvaluations.some((evaluation:any) => evaluation.hasOurMentorId);
            if (hasReferences) {
                diagnosis.recommendations.push('🔍 Se encontraron referencias al mentorId en otras propiedades');
            } else {
                diagnosis.recommendations.push('❌ No se encontraron referencias al mentorId en ninguna evaluación');
            }
        }

        console.log('✅ [test-assistant] Diagnóstico completado:', diagnosis);

        res.status(200).json(diagnosis);
    } catch (err: any) {
        console.error('❌ [test-assistant] Error:', err);
        res.status(500).json({ 
            error: 'Error en prueba de assistant',
            details: err.message
        });
    }
});

// Endpoint específico para diagnosticar problemas de assistants
app.post('/api/mentors/assistant-debug', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const email = (req as any).user4GeeksData?.email;
        const userRoles = (req as any).user4GeeksData?.roles || [];
        
        if (!email) {
            return res.status(400).json({ error: 'No se encontró email en el token' });
        }

        const isAssistant = userRoles.some((roleObj: any) =>
            roleObj.role === 'assistant' && roleObj.academy && roleObj.academy.id === 6
        );

        if (!isAssistant) {
            return res.status(400).json({ error: 'Este endpoint es solo para assistants' });
        }

        console.log('🔍 [assistant-debug] Iniciando diagnóstico para assistant:', email);

        // Obtener mentorId
        let mentorId: string;
        try {
            mentorId = await resolveMentorIdFromReq(req);
        } catch (error: any) {
            return res.status(400).json({ error: error.message });
        }

        const NPS_DB = process.env.NOTION_NPS_DATABASE_ID || '';
        if (!NPS_DB) {
            return res.status(500).json({ error: 'Falta NOTION_NPS_DATABASE_ID' });
        }

        // Probar diferentes tipos de filtros para assistants
        const filterTests = [
            {
                name: 'Filtro T.A. con rollup (actual)',
                filter: {
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
                }
            },
            {
                name: 'Filtro T.A. directo (sin rollup)',
                filter: {
                    property: 'T.A.',
                    relation: {
                        contains: mentorId
                    }
                }
            },
            {
                name: 'Filtro T.A. con contains directo',
                filter: {
                    property: 'T.A.',
                    contains: mentorId
                }
            }
        ];

        const results = [];

        for (const test of filterTests) {
            try {
                console.log(`🔍 [assistant-debug] Probando: ${test.name}`);
                
                const queryResult = await notion.databases.query({
                    database_id: NPS_DB,
                    filter: test.filter as any
                });

                results.push({
                    filterName: test.name,
                    filter: test.filter,
                    totalResults: queryResult.results?.length || 0,
                    success: true,
                    error: null,
                    sampleResults: queryResult.results?.slice(0, 2).map((page: any) => ({
                        id: page.id,
                        npsId: page.properties?.['NPS ID']?.title?.[0]?.plain_text || 'Sin ID',
                        taRelation: page.properties?.['T.A.']?.relation || page.properties?.['T.A.']?.rollup || 'Sin relación'
                    })) || []
                });

                console.log(`✅ [assistant-debug] ${test.name}: ${queryResult.results?.length || 0} resultados`);
            } catch (error: any) {
                results.push({
                    filterName: test.name,
                    filter: test.filter,
                    totalResults: 0,
                    success: false,
                    error: error.message,
                    sampleResults: []
                });
                console.log(`❌ [assistant-debug] ${test.name}: Error - ${error.message}`);
            }
        }

        // También obtener información sobre la estructura de la base de datos
        let databaseInfo = null;
        try {
            const dbInfo = await notion.databases.retrieve({ database_id: NPS_DB });
            databaseInfo = {
                id: dbInfo.id,
                title: (dbInfo as any).title?.[0]?.plain_text || 'Sin título',
                properties: Object.keys((dbInfo as any).properties || {}),
                taPropertyExists: !!(dbInfo as any).properties?.['T.A.'],
                taPropertyType: (dbInfo as any).properties?.['T.A.']?.type || 'No encontrado'
            };
        } catch (error: any) {
            databaseInfo = { error: error.message };
        }

        const diagnosis = {
            userInfo: {
                email,
                mentorId,
                roles: userRoles,
                isAssistant
            },
            databaseInfo,
            filterTests: results,
            recommendations: []
        };

        // Generar recomendaciones
        const successfulFilters = results.filter(r => r.success && r.totalResults > 0);
        const failedFilters = results.filter(r => !r.success);

        if (successfulFilters.length === 0) {
            diagnosis.recommendations.push('Ningún filtro encontró evaluaciones - verificar que el assistant esté asociado a evaluaciones NPS');
        } else {
            diagnosis.recommendations.push(`Usar el filtro "${successfulFilters[0].filterName}" que encontró ${successfulFilters[0].totalResults} evaluaciones`);
        }

        if (failedFilters.length > 0) {
            diagnosis.recommendations.push('Algunos filtros fallaron - verificar la estructura de la base de datos NPS');
        }

        console.log('✅ [assistant-debug] Diagnóstico completado:', diagnosis);

        res.status(200).json(diagnosis);
    } catch (err: any) {
        console.error('❌ [assistant-debug] Error:', err);
        res.status(500).json({ 
            error: 'Error en diagnóstico de assistant',
            details: err.message
        });
    }
});

// Endpoint para demostrar el problema de tipos con mentorId
app.post('/api/mentors/type-demo', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const { mentorId: mentorIdFromBody } = req.body;

        // ❌ PROBLEMA: Asignación directa sin validación de tipos
        let mentorIdProblematic = mentorIdFromBody;
        
        // ✅ SOLUCIÓN: Procesamiento seguro de tipos
        let mentorIdSafe: string | undefined = undefined;
        
        if (mentorIdFromBody !== undefined && mentorIdFromBody !== null) {
            if (typeof mentorIdFromBody === 'string') {
                mentorIdSafe = mentorIdFromBody.trim();
            } else if (typeof mentorIdFromBody === 'number') {
                mentorIdSafe = mentorIdFromBody.toString();
            }
        }

        const demo = {
            input: {
                value: mentorIdFromBody,
                type: typeof mentorIdFromBody,
                isString: typeof mentorIdFromBody === 'string',
                isNumber: typeof mentorIdFromBody === 'number',
                isBoolean: typeof mentorIdFromBody === 'boolean',
                isObject: typeof mentorIdFromBody === 'object',
                isNull: mentorIdFromBody === null,
                isUndefined: mentorIdFromBody === undefined
            },
            problematicAssignment: {
                value: mentorIdProblematic,
                type: typeof mentorIdProblematic,
                canBeAssignedToString: typeof mentorIdProblematic === 'string',
                problems: []
            },
            safeProcessing: {
                value: mentorIdSafe,
                type: typeof mentorIdSafe,
                isValidString: typeof mentorIdSafe === 'string',
                isValidUUIDWithDashes: mentorIdSafe && typeof mentorIdSafe === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(mentorIdSafe),
                isValidUUIDWithoutDashes: mentorIdSafe && typeof mentorIdSafe === 'string' && /^[a-f0-9]{32}$/i.test(mentorIdSafe),
                isReadyForNotion: mentorIdSafe && typeof mentorIdSafe === 'string' && 
                    (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(mentorIdSafe) || 
                     /^[a-f0-9]{32}$/i.test(mentorIdSafe))
            }
        };

        // Identificar problemas potenciales
        if (typeof mentorIdProblematic !== 'string') {
            demo.problematicAssignment.problems.push(`Tipo incorrecto: ${typeof mentorIdProblematic}`);
        }
        if (mentorIdProblematic && typeof mentorIdProblematic === 'string' && 
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(mentorIdProblematic) && 
            !/^[a-f0-9]{32}$/i.test(mentorIdProblematic)) {
            demo.problematicAssignment.problems.push('Formato UUID inválido (debe ser con o sin guiones)');
        }

        res.status(200).json({
            message: 'Demostración del problema de tipos con mentorId',
            explanation: {
                problem: 'let mentorId = mentorIdFromBody puede asignar cualquier tipo',
                solution: 'Procesar mentorIdFromBody de forma segura antes de asignar',
                types: {
                    mentorIdFromBody: 'any (puede ser cualquier tipo)',
                    mentorIdSafe: 'string | undefined (tipo seguro)'
                }
            },
            demo,
            recommendations: [
                'Siempre valida el tipo antes de asignar',
                'Convierte tipos compatibles (number -> string)',
                'Rechaza tipos incompatibles (boolean, object, etc.)',
                'Usa TypeScript para detectar estos problemas en tiempo de compilación'
            ]
        });

    } catch (err: any) {
        console.error('❌ [type-demo] Error:', err);
        res.status(500).json({ 
            error: 'Error en demostración de tipos',
            details: err.message
        });
    }
});

// Endpoint para obtener información detallada sobre el mentorId
app.get('/api/mentors/mentor-id-info', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const email = (req as any).user4GeeksData?.email;
        if (!email) {
            return res.status(400).json({ error: 'No se encontró email en el token' });
        }

        console.log('🔍 [mentor-id-info] Obteniendo información del mentorId para:', email);

        // Intentar resolver el mentorId
        let mentorId: string;
        let mentorInfo: any = null;
        let error: any = null;

        try {
            mentorId = await resolveMentorIdFromReq(req);
            
            // Obtener información adicional del mentor
            const mentorPage = await notion.pages.retrieve({ page_id: mentorId });
            mentorInfo = {
                id: mentorPage.id,
                name: (mentorPage as any).properties?.Name?.title?.[0]?.plain_text || 'Sin nombre',
                email: (mentorPage as any).properties?.Correo?.email || 'Sin email',
                createdTime: (mentorPage as any).created_time,
                lastEditedTime: (mentorPage as any).last_edited_time
            };
        } catch (err: any) {
            error = {
                message: err.message,
                code: err.code,
                type: err.type
            };
        }

        const response = {
            userEmail: email,
            mentorId: mentorId || null,
            mentorInfo,
            error,
            mentorIdFormat: {
                expected: 'UUID de Notion (32 caracteres)',
                example: '1234567890abcdef1234567890abcdef',
                description: 'El mentorId es el ID único de la página del mentor en Notion'
            },
            howToUse: {
                inRequestBody: 'Puedes enviar mentorId en el body de la request',
                autoResolve: 'Si no envías mentorId, se resuelve automáticamente desde el token',
                validation: 'El mentorId debe ser un string de 32 caracteres'
            },
            troubleshooting: error ? [
                'El mentor no está registrado en la base de datos de Notion',
                'Verifica que el email coincida exactamente',
                'Verifica que la propiedad se llame "Correo" en Notion',
                'Usa POST /api/mentors/debug para más detalles'
            ] : [
                'MentorId válido encontrado',
                'Puedes usar este mentorId en las requests'
            ]
        };

        console.log('✅ [mentor-id-info] Información obtenida:', response);

        res.status(200).json(response);
    } catch (err: any) {
        console.error('❌ [mentor-id-info] Error:', err);
        res.status(500).json({ 
            error: 'Error obteniendo información del mentorId',
            details: err.message
        });
    }
});

// Endpoint para diagnosticar problemas con mentores
app.post('/api/mentors/debug', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const email = (req as any).user4GeeksData?.email;
        if (!email) {
            return res.status(400).json({ error: 'No se encontró email en el token' });
        }

        const MENTORS_DB = process.env.NOTION_MENTORS_DATABASE_ID || '';
        if (!MENTORS_DB) {
            return res.status(500).json({ error: 'Falta NOTION_MENTORS_DATABASE_ID' });
        }

        console.log('🔍 [mentors/debug] Iniciando diagnóstico para email:', email);

        // Información del usuario autenticado
        const userInfo = {
            email: email,
            firstName: (req as any).user4GeeksData?.first_name,
            lastName: (req as any).user4GeeksData?.last_name,
            username: (req as any).user4GeeksData?.username,
            roles: (req as any).user4GeeksData?.roles || []
        };

        // Intentar buscar el mentor
        let mentorResult = null;
        let mentorError = null;
        
        try {
            mentorResult = await notion.databases.query({
                database_id: MENTORS_DB,
                filter: { property: 'Correo', email: { equals: email } }
            });
        } catch (error: any) {
            mentorError = {
                message: error.message,
                code: error.code,
                type: error.type
            };
        }

        // Información de diagnóstico
        const diagnosis = {
            userInfo,
            databaseInfo: {
                mentorsDatabaseId: MENTORS_DB,
                databaseConfigured: !!MENTORS_DB
            },
            searchResult: {
                found: mentorResult ? !!mentorResult.results?.length : false,
                totalResults: mentorResult?.results?.length || 0,
                error: mentorError
            },
            mentorInfo: mentorResult?.results?.length ? {
                id: mentorResult.results[0].id,
                name: (mentorResult.results[0] as any).properties?.Name?.title?.[0]?.plain_text || 'Sin nombre',
                email: (mentorResult.results[0] as any).properties?.Correo?.email || 'Sin email'
            } : null,
            recommendations: []
        };

        // Generar recomendaciones
        if (!mentorResult?.results?.length) {
            diagnosis.recommendations.push('El mentor no está registrado en la base de datos de Notion');
            diagnosis.recommendations.push('Verifica que el email coincida exactamente con el registrado en Notion');
            diagnosis.recommendations.push('Verifica que la propiedad se llame "Correo" en la base de datos');
        }

        if (mentorError) {
            diagnosis.recommendations.push('Error en la consulta a Notion - verifica la configuración de la base de datos');
        }

        console.log('📊 [mentors/debug] Diagnóstico completado:', diagnosis);

        res.status(200).json(diagnosis);
    } catch (err: any) {
        console.error('❌ [mentors/debug] Error en diagnóstico:', err);
        res.status(500).json({ 
            error: 'Error en diagnóstico de mentor',
            details: err.message
        });
    }
});

app.get('/api/mentors/me', authorizeTeachersOrAssistants(), async (req, res) => {
    try {
        const email = (req as any).user4GeeksData?.email;
        if (!email) {
            console.error('❌ [mentors/me] No se encontró email en el token');
            return res.status(400).json({ error: 'No se encontró email en el token' });
        }

        const MENTORS_DB = process.env.NOTION_MENTORS_DATABASE_ID || '';
        if (!MENTORS_DB) {
            console.error('❌ [mentors/me] Falta NOTION_MENTORS_DATABASE_ID en variables de entorno');
            return res.status(500).json({ error: 'Falta NOTION_MENTORS_DATABASE_ID' });
        }

        console.log('🔍 [mentors/me] Buscando mentor con email:', email);

        const result = await notion.databases.query({
            database_id: MENTORS_DB,
            filter: { property: 'Correo', email: { equals: email } }
        });

        console.log('📊 [mentors/me] Resultado de la consulta:', {
            totalResults: result.results?.length || 0,
            hasResults: !!result.results?.length,
            email: email
        });

        if (!result.results?.length) {
            console.error('❌ [mentors/me] Mentor no encontrado para email:', email);
            console.error('❌ [mentors/me] Posibles causas:');
            console.error('   - El email no existe en la base de datos de mentores');
            console.error('   - El nombre de la propiedad "Correo" es incorrecto');
            console.error('   - El formato del email no coincide exactamente');
            console.error('   - El mentor no está registrado en Notion');
            return res.status(404).json({ 
                error: 'Mentor no encontrado',
                details: `No se encontró un mentor registrado con el email: ${email}`,
                troubleshooting: {
                    checkEmail: 'Verifica que el email sea correcto',
                    checkNotion: 'Verifica que el mentor esté registrado en la base de datos de Notion',
                    checkProperty: 'Verifica que la propiedad se llame "Correo" en Notion'
                }
            });
        }

        const page = result.results[0] as any;
        const name =
            page.properties?.Name?.title?.[0]?.plain_text ||
            page.properties?.Title?.title?.[0]?.plain_text ||
            [(req as any).user4GeeksData?.first_name, (req as any).user4GeeksData?.last_name]
                .filter(Boolean)
                .join(' ') ||
            (req as any).user4GeeksData?.username;

        console.log('✅ [mentors/me] Mentor encontrado:', {
            mentorId: page.id,
            name: name?.trim() || null,
            email
        });

        res.status(200).json({
            id: page.id,
            name: name?.trim() || null,
            email
        });
    } catch (err: any) {
        console.error('❌ [mentors/me] Error consultando mentor:', {
            error: err.message,
            errorCode: err.code,
            errorType: err.type,
            email: (req as any).user4GeeksData?.email
        });
        res.status(500).json({ 
            error: 'Error al consultar mentor',
            details: err.message
        });
    }
});

function isISODateString(dateStr: string) {
    // Verifica si el string es un ISO 8601 válido (YYYY-MM-DDTHH:mm o similar)
    return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dateStr);
}

// Endpoint de prueba para verificar que el servidor funciona
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        variables: {
            notionToken: process.env.NOTION_TOKEN ? '✅ Configurado' : '❌ Faltante',
            npsDatabase: process.env.NOTION_NPS_DATABASE_ID ? '✅ Configurado' : '❌ Faltante',
            mentorsDatabase: process.env.NOTION_MENTORS_DATABASE_ID ? '✅ Configurado' : '❌ Faltante',
            breathcodeUrl: process.env.BREATHCODE_API_URL ? '✅ Configurado' : '❌ Faltante'
        }
    });
});

app.listen(5000, () => console.log('Server ready on port 5000.'));

export default app;
