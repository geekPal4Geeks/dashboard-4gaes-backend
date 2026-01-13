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
import {
    getCurrentPeriodDates,
    getPreviousPeriodDates,
    getCurrentMonthlyPeriodDates,
    getPreviousMonthlyPeriodDates
} from './utils/dateCalculations.js';
import {
    MentorshipSession,
    getMentorshipStartTime,
    getMentorshipEndTime,
    calculateDuration,
    determineServiceType,
    calculateMentorshipStatus,
    getStudentName,
    getServiceName,
} from './utils/mentorshipProcessing.js';
import { fetchMentorSessions } from './utils/breathcodeApi.js';
import {
    ProcessedMentorship,
    generateMonthlySummaries,
} from './utils/monthlySummaries.js';



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

// Endpoint de prueba para /api/mentor-nps que acepta email directamente (sin autenticación)
// Úsese solo para testing/debugging - DEBE IR ANTES del middleware de autenticación
app.post('/api/mentor-nps-test', async (req, res) => {
    try {
        const { email, mentorId: mentorIdFromBody, startDate, endDate, includePast = true } = req.body;

        if (!email && !mentorIdFromBody) {
            return res.status(400).json({
                error: 'Se requiere email o mentorId',
                example: { email: 'hector@chocbar.net' }
            });
        }

        console.log('🔍 [mentor-nps-test] Iniciando prueba para:', email || mentorIdFromBody);

        // Simular el request con user4GeeksData para usar las funciones existentes
        const mockReq = {
            ...req,
            user4GeeksData: {
                email: email,
                roles: [] // Se determinará después
            }
        } as any;

        let mentorId: string | undefined = mentorIdFromBody;

        // Si no se proporciona mentorId, resolverlo desde el email
        if (!mentorId && email) {
            console.log('🔍 [mentor-nps-test] Resolviendo mentorId desde email:', email);
            try {
                mentorId = await resolveMentorIdFromReq(mockReq);
                console.log('✅ [mentor-nps-test] MentorId resuelto:', mentorId);
            } catch (error: any) {
                console.error('❌ [mentor-nps-test] Error resolviendo mentorId:', error.message);
                return res.status(400).json({
                    error: 'Error resolviendo mentorId',
                    details: error.message,
                    email: email,
                    troubleshooting: {
                        checkEmail: 'Verifica que el email del usuario esté registrado en la base de datos de mentores',
                        checkNotion: 'Verifica que el mentor esté registrado en Notion con el email correcto',
                        checkProperty: 'Verifica que la propiedad se llame "Correo" en la base de datos de mentores'
                    }
                });
            }
        }

        // Validar formato UUID
        if (!mentorId) {
            return res.status(400).json({
                error: 'MentorId faltante',
                details: 'No se pudo obtener el mentorId ni del body ni del email'
            });
        }

        const uuidWithDashesRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        const uuidWithoutDashesRegex = /^[a-f0-9]{32}$/i;

        if (!uuidWithDashesRegex.test(mentorId) && !uuidWithoutDashesRegex.test(mentorId)) {
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
        console.log('✅ [mentor-nps-test] MentorId procesado:', {
            original: originalMentorId,
            normalized: normalizedMentorId,
            length: normalizedMentorId.length
        });

        const NPS_DB = process.env.NOTION_NPS_DATABASE_ID || '';
        if (!NPS_DB) {
            return res.status(500).json({ error: 'Falta NOTION_NPS_DATABASE_ID en variables de entorno' });
        }

        // NUEVA ESTRATEGIA: Primero buscar todas las cohortes del mentor, luego buscar evaluaciones de esas cohortes
        // Esto es más robusto que depender solo del filtro de rollup de Notion
        const COHORTS_DB_FOR_EVALS_SEARCH = process.env.NOTION_COHORTS_DATABASE_ID || process.env.NOTION_DATABASE_ID || '';
        console.log('🔍 [mentor-nps-test] Estrategia mejorada: Buscando cohortes primero, luego evaluaciones');

        // Paso 1: Buscar todas las cohortes asignadas al mentor
        const COHORTS_DB = process.env.NOTION_DATABASE_ID || '';
        let allMentorCohortIds = new Set<string>();

        if (COHORTS_DB && COHORTS_DB_FOR_EVALS_SEARCH) {
            try {
                // Buscar en T.A. (directo y rollup)
                try {
                    const taDirectQuery = await notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: { property: 'T.A.', relation: { contains: originalMentorId } },
                        page_size: 100
                    });
                    taDirectQuery.results?.forEach((page: any) => allMentorCohortIds.add(page.id));

                    const taRollupQuery = await notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: { property: 'T.A.', rollup: { any: { relation: { contains: originalMentorId } } } },
                        page_size: 100
                    });
                    taRollupQuery.results?.forEach((page: any) => allMentorCohortIds.add(page.id));
                } catch (error: any) {
                    console.log(`⚠️ [mentor-nps-test] Error buscando T.A.: ${error.message}`);
                }

                // Buscar en Teacher (directo y rollup)
                try {
                    const teacherDirectQuery = await notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: { property: 'Teacher', relation: { contains: originalMentorId } },
                        page_size: 100
                    });
                    teacherDirectQuery.results?.forEach((page: any) => allMentorCohortIds.add(page.id));

                    const teacherRollupQuery = await notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: { property: 'Teacher', rollup: { any: { relation: { contains: originalMentorId } } } },
                        page_size: 100
                    });
                    teacherRollupQuery.results?.forEach((page: any) => allMentorCohortIds.add(page.id));
                } catch (error: any) {
                    console.log(`⚠️ [mentor-nps-test] Error buscando Teacher: ${error.message}`);
                }

                console.log(`📊 [mentor-nps-test] Cohortes encontradas del mentor: ${allMentorCohortIds.size}`);
            } catch (error: any) {
                console.log(`⚠️ [mentor-nps-test] Error buscando cohortes: ${error.message}`);
            }
        }

        // Paso 2: Para cada cohorte, buscar directamente sus evaluaciones NPS relacionadas
        let allPages: any[] = [];
        let isAssistant = false;
        let isTeacher = false;

        if (allMentorCohortIds.size > 0) {
            try {
                const cohortIdsArray = Array.from(allMentorCohortIds);
                console.log(`🔍 [mentor-nps-test] Buscando evaluaciones NPS para ${cohortIdsArray.length} cohortes...`);

                // Si hay muchas cohortes, dividir en lotes (Notion tiene límites en filtros OR)
                const BATCH_SIZE = 10;
                for (let i = 0; i < cohortIdsArray.length; i += BATCH_SIZE) {
                    const batch = cohortIdsArray.slice(i, i + BATCH_SIZE);

                    // Buscar evaluaciones que tengan CUALQUIERA de estas cohortes
                    const cohortFilter = {
                        or: batch.map(cohortId => ({
                            property: 'Cohorts',
                            relation: { contains: cohortId }
                        }))
                    };

                    // Agregar filtros de fecha si existen
                    let finalFilter: any = cohortFilter;
                    if (startDate || endDate) {
                        const dateFilters: any[] = [];
                        if (startDate) {
                            dateFilters.push({
                                property: 'NPS ID',
                                title: { starts_with: startDate.substring(0, 7) }
                            });
                        }
                        if (endDate) {
                            dateFilters.push({
                                property: 'NPS ID',
                                title: { starts_with: endDate.substring(0, 7) }
                            });
                        }
                        finalFilter = { and: [cohortFilter, ...dateFilters] };
                    }

                    const batchResults = await notionQueryAll(NPS_DB, finalFilter);
                    allPages.push(...batchResults);
                    console.log(`📊 [mentor-nps-test] Lote ${Math.floor(i / BATCH_SIZE) + 1}: ${batchResults.length} evaluaciones encontradas`);
                }

                // Eliminar duplicados (una evaluación puede estar relacionada a múltiples cohortes)
                const uniquePageIds = new Set();
                allPages = allPages.filter(page => {
                    if (uniquePageIds.has(page.id)) {
                        return false;
                    }
                    uniquePageIds.add(page.id);
                    return true;
                });

                console.log(`✅ [mentor-nps-test] Total evaluaciones encontradas para cohortes del mentor: ${allPages.length}`);

                // Si encontramos evaluaciones, determinar el rol basándonos en la primera evaluación
                if (allPages.length > 0) {
                    const firstPage = allPages[0];
                    const firstProps = (firstPage as any).properties || {};

                    // Verificar si tiene T.A. o Teacher
                    const hasTA = !!(firstProps['T.A.']?.relation || firstProps['T.A.']?.rollup);
                    const hasTeacher = !!(firstProps['Teacher']?.relation || firstProps['Teacher']?.rollup);

                    // Intentar determinar el rol: si el mentor está en T.A., es assistant; si está en Teacher, es teacher
                    const taRelation = firstProps['T.A.']?.relation || firstProps['T.A.']?.rollup?.array?.[0]?.relation || [];
                    const taIds = taRelation.map((t: any) => t.id).filter((id: string) => typeof id === 'string');
                    const normalizedTaIds = taIds.map((id: string) => id.replace(/-/g, ''));

                    if (normalizedTaIds.includes(normalizedMentorId)) {
                        isAssistant = true;
                        console.log(`✅ [mentor-nps-test] Rol determinado: Assistant (encontrado en T.A.)`);
                    } else {
                        const teacherRelation = firstProps['Teacher']?.relation || firstProps['Teacher']?.rollup?.array?.[0]?.relation || [];
                        const teacherIds = teacherRelation.map((t: any) => t.id).filter((id: string) => typeof id === 'string');
                        const normalizedTeacherIds = teacherIds.map((id: string) => id.replace(/-/g, ''));

                        if (normalizedTeacherIds.includes(normalizedMentorId)) {
                            isTeacher = true;
                            console.log(`✅ [mentor-nps-test] Rol determinado: Teacher (encontrado en Teacher)`);
                        }
                    }
                }
            } catch (error: any) {
                console.log(`⚠️ [mentor-nps-test] Error buscando evaluaciones por cohortes: ${error.message}`);
                console.error('Stack:', error.stack);
            }
        }

        // Paso 3: También intentar el método tradicional (filtro por rollup) como respaldo
        // Esto captura evaluaciones que podrían no estar vinculadas correctamente a las cohortes
        if (allPages.length === 0) {
            console.log('🔍 [mentor-nps-test] Método tradicional: Buscando por rollup T.A./Teacher');

            let filter: any = {
                and: [{
                    property: 'T.A.',
                    rollup: { any: { relation: { contains: originalMentorId } } }
                }]
            };

            if (startDate) {
                filter.and.push({ property: 'NPS ID', title: { starts_with: startDate.substring(0, 7) } });
            }
            if (endDate) {
                filter.and.push({ property: 'NPS ID', title: { starts_with: endDate.substring(0, 7) } });
            }

            try {
                const rollupResults = await notionQueryAll(NPS_DB, filter);
                if (rollupResults.length > 0) {
                    isAssistant = true;
                    allPages.push(...rollupResults);
                    console.log(`✅ [mentor-nps-test] Método rollup T.A. encontró ${rollupResults.length} evaluaciones`);
                }
            } catch (error: any) {
                console.log(`⚠️ [mentor-nps-test] Error método rollup T.A.: ${error.message}`);
            }

            if (allPages.length === 0) {
                filter = {
                    and: [{
                        property: 'Teacher',
                        rollup: { any: { relation: { contains: originalMentorId } } }
                    }]
                };

                if (startDate) {
                    filter.and.push({ property: 'NPS ID', title: { starts_with: startDate.substring(0, 7) } });
                }
                if (endDate) {
                    filter.and.push({ property: 'NPS ID', title: { starts_with: endDate.substring(0, 7) } });
                }

                try {
                    const rollupResults = await notionQueryAll(NPS_DB, filter);
                    if (rollupResults.length > 0) {
                        isTeacher = true;
                        allPages.push(...rollupResults);
                        console.log(`✅ [mentor-nps-test] Método rollup Teacher encontró ${rollupResults.length} evaluaciones`);
                    }
                } catch (error: any) {
                    console.log(`⚠️ [mentor-nps-test] Error método rollup Teacher: ${error.message}`);
                }
            }
        }

        if (allPages.length === 0) {
            return res.status(200).json({
                success: false,
                message: 'No se encontraron evaluaciones NPS para este mentor',
                email: email,
                mentorId: originalMentorId,
                cohortesEncontradas: allMentorCohortIds.size,
                recommendations: [
                    'Verifica que el mentor esté asignado como T.A. o Teacher en las evaluaciones NPS en Notion',
                    'Verifica que las evaluaciones NPS tengan relación con las cohortes del mentor',
                    'Usa /api/mentors/test-assistant con el email para más diagnósticos'
                ]
            });
        }

        // Eliminar duplicados finales
        const finalUniqueIds = new Set();
        allPages = allPages.filter(page => {
            if (finalUniqueIds.has(page.id)) return false;
            finalUniqueIds.add(page.id);
            return true;
        });

        console.log(`📊 [mentor-nps-test] Total evaluaciones únicas encontradas: ${allPages.length}`);
        console.log(`📊 [mentor-nps-test] Rol detectado: ${isAssistant ? 'assistant' : isTeacher ? 'teacher' : 'desconocido'}`);

        // Mostrar muestra de evaluaciones encontradas
        if (allPages.length > 0) {
            console.log('📋 [mentor-nps-test] Muestra de evaluaciones encontradas (primeras 3):');
            allPages.slice(0, 3).forEach((page: any) => {
                const props = page.properties || {};
                const evalNpsId = props['NPS ID']?.title?.[0]?.plain_text || 'sin ID';
                const evalCohortRelation = props['Cohorts']?.relation || [];
                const evalCohortIds = evalCohortRelation.map((c: any) => c.id);
                console.log(`  - NPS ${evalNpsId}: cohortes ${evalCohortIds.length}`);
            });
        }

        // Filtrar evaluaciones que realmente corresponden al mentor
        const pages: any[] = [];
        const skippedEvaluations: any[] = [];

        // IMPORTANTE: Verificar tanto TA como Teacher en cada evaluación, ya que el mentor
        // puede ser TA en unas evaluaciones y Teacher en otras de la misma cohorte
        for (const page of allPages) {
            const props = (page as any).properties || {};
            const npsId = props['NPS ID']?.title?.[0]?.plain_text || 'sin ID';
            const cohortRelation = props['Cohorts']?.relation || [];
            const cohortIdsInEval = cohortRelation.map((c: any) => c.id);

            // Verificar si está como TA
            const taRelation = props['T.A.']?.relation || props['T.A.']?.rollup?.array?.[0]?.relation || [];
            const taIds = taRelation.map((t: any) => t.id);
            const normalizedTaIds = taIds.map((id: string) => id.replace(/-/g, ''));
            const isMentorTA = normalizedTaIds.includes(normalizedMentorId);

            // Verificar si está como Teacher
            const teacherRelation = props['Teacher']?.relation || props['Teacher']?.rollup?.array?.[0]?.relation || [];
            const teacherIds = teacherRelation.map((t: any) => t.id);
            const normalizedTeacherIds = teacherIds.map((id: string) => id.replace(/-/g, ''));

            // Si está como TA, incluirlo como assistant
            if (isMentorTA) {
                pages.push(page);
                isAssistant = true; // Actualizar el rol detectado
                console.log(`✅ [mentor-nps-test] Evaluación ${npsId} INCLUIDA - Mentor está como TA`);
            }
            // Si está como Teacher, verificar responsabilidad
            else if (normalizedTeacherIds.includes(normalizedMentorId)) {
                const mentorChangeDate = props['Mentor Change Date']?.rollup?.array?.[0]?.date?.start || null;

                // Extraer fecha de evaluación
                const evaluationDate = props['Date of Creation']?.date?.start ||
                    props['Date of Creation']?.rich_text?.[0]?.plain_text ||
                    page.created_time ||
                    props['NPS ID']?.title?.[0]?.plain_text || '';

                // Determinar si el mentor actual es responsable de esta evaluación
                const responsibility = isMentorResponsibleForEvaluation(
                    evaluationDate,
                    mentorChangeDate,
                    teacherIds,
                    normalizedMentorId
                );

                if (responsibility.isResponsible) {
                    pages.push(page);
                    isTeacher = true; // Actualizar el rol detectado
                    console.log(`✅ [mentor-nps-test] Evaluación ${npsId} INCLUIDA - Mentor responsable como Teacher`);
                } else {
                    skippedEvaluations.push({
                        npsId,
                        reason: responsibility.reason,
                        teacherIds,
                        cohortIds: cohortIdsInEval
                    });
                    console.log(`⚠️ [mentor-nps-test] Evaluación ${npsId} OMITIDA - ${responsibility.reason}`);
                }
            } else {
                // No está ni como TA ni como Teacher
                skippedEvaluations.push({
                    npsId,
                    reason: 'Mentor no está como TA ni como Teacher en la evaluación',
                    taIds,
                    teacherIds,
                    cohortIds: cohortIdsInEval
                });
                console.log(`⚠️ [mentor-nps-test] Evaluación ${npsId} OMITIDA - Mentor no está como TA ni Teacher`, {
                    mentorId: normalizedMentorId,
                    taIds: normalizedTaIds.slice(0, 3),
                    teacherIds: normalizedTeacherIds.slice(0, 3)
                });
            }
        }

        console.log('📊 [mentor-nps-test] Resumen de filtrado:', {
            totalEncontradas: allPages.length,
            incluidas: pages.length,
            omitidas: skippedEvaluations.length,
            rolUsado: isAssistant ? 'assistant' : isTeacher ? 'teacher' : 'desconocido'
        });

        // Mostrar muestra de evaluaciones omitidas para diagnóstico
        if (skippedEvaluations.length > 0 && skippedEvaluations.length <= 5) {
            console.log('🔍 [mentor-nps-test] Muestra de evaluaciones omitidas:');
            skippedEvaluations.forEach((skip: any) => {
                console.log(`  - NPS ${skip.npsId}: ${skip.reason}`);
                if (skip.taIds && skip.taIds.length > 0) {
                    console.log(`    TAs en evaluación: ${skip.taIds.slice(0, 3).join(', ')}${skip.taIds.length > 3 ? '...' : ''}`);
                }
                if (skip.teacherIds && skip.teacherIds.length > 0) {
                    console.log(`    Teachers en evaluación: ${skip.teacherIds.slice(0, 3).join(', ')}${skip.teacherIds.length > 3 ? '...' : ''}`);
                }
            });
        }

        // Agrupar evaluaciones por cohorte
        const cohortIdsSet = new Set<string>();
        const cohortEvaluations = new Map<string, any[]>();

        for (const page of pages) {
            const props = (page as any).properties || {};
            const cohortRelation = props['Cohorts']?.relation || [];
            const npsId = props['NPS ID']?.title?.[0]?.plain_text || 'sin ID';

            for (const cohort of cohortRelation) {
                const cohortId = cohort.id;
                cohortIdsSet.add(cohortId);

                if (!cohortEvaluations.has(cohortId)) {
                    cohortEvaluations.set(cohortId, []);
                }
                cohortEvaluations.get(cohortId)!.push({
                    npsId,
                    cohortId
                });
            }
        }

        // Nota: Ya no necesitamos buscar específicamente cohortes activas porque ahora buscamos
        // todas las evaluaciones de todas las cohortes del mentor desde el principio

        // Ya tenemos todas las cohortes del mentor en allMentorCohortIds (encontradas al principio)
        // Ahora agregar cualquier cohorte adicional que encontramos en las evaluaciones pero que no estaba en allMentorCohortIds
        // y también agregar las cohortes de allMentorCohortIds que no tienen evaluaciones
        const cohortIdsFromEvaluations = Array.from(cohortIdsSet);
        const additionalCohortIds = Array.from(allMentorCohortIds).filter(id => !cohortIdsFromEvaluations.includes(id));

        // Combinar todas las cohortes: las de las evaluaciones + las adicionales del mentor
        additionalCohortIds.forEach(id => cohortIdsSet.add(id));
        allMentorCohortIds.forEach(id => cohortIdsSet.add(id));

        console.log(`📊 [mentor-nps-test] Cohortes totales: ${cohortIdsSet.size} (${cohortIdsFromEvaluations.length} con evaluaciones, ${additionalCohortIds.length} adicionales sin evaluaciones)`);

        // Obtener información de todas las cohortes
        const allCohortIds = Array.from(cohortIdsSet);
        const cohortPages = await Promise.all(
            allCohortIds.map(async (id) => {
                try {
                    return await notion.pages.retrieve({ page_id: id });
                } catch (error) {
                    return null;
                }
            })
        );

        // Procesar información de cohortes
        const cohortsInfo = cohortPages
            .filter(p => p !== null)
            .map((page: any) => {
                const cohortId = page.id;
                const statusProp1 = page.properties?.['Cohort Status ']?.select?.name;
                const statusProp2 = page.properties?.['Cohort Status']?.select?.name;
                const statusProp3 = page.properties?.Status?.select?.name;
                const status = statusProp1 || statusProp2 || statusProp3 || 'sin estado';
                const cohortName = page.properties?.Cohort?.title?.[0]?.plain_text ||
                    page.properties?.Title?.title?.[0]?.plain_text ||
                    'Cohorte sin nombre';

                const evaluations = cohortEvaluations.get(cohortId) || [];
                const isActive = status === 'Active' || status === 'Final Project';
                const isPast = status === 'Finished';

                return {
                    cohortId,
                    cohortName,
                    status,
                    isActive,
                    isPast,
                    totalEvaluations: evaluations.length,
                    evaluationIds: evaluations.map(e => e.npsId),
                    hasEvaluations: evaluations.length > 0,
                    isAdditionalCohort: additionalCohortIds.includes(cohortId)
                };
            });

        const activeCohorts = cohortsInfo.filter(c => c.isActive);
        const pastCohorts = cohortsInfo.filter(c => c.isPast);
        const otherCohorts = cohortsInfo.filter(c => !c.isActive && !c.isPast);

        // Construir respuesta
        const response = {
            success: true,
            message: 'Evaluaciones encontradas',
            email: email,
            mentorId: originalMentorId,
            normalizedMentorId: normalizedMentorId,
            role: isAssistant ? 'assistant' : 'teacher',
            totalEvaluations: pages.length,
            cohorts: {
                total: cohortsInfo.length,
                active: activeCohorts.length,
                past: pastCohorts.length,
                other: otherCohorts.length,
                activeCohorts: activeCohorts.map(c => ({
                    name: c.cohortName,
                    status: c.status,
                    totalEvaluations: c.totalEvaluations,
                    evaluationIds: c.evaluationIds,
                    hasEvaluations: c.hasEvaluations,
                    isAdditionalCohort: c.isAdditionalCohort
                })),
                pastCohorts: pastCohorts.map(c => ({
                    name: c.cohortName,
                    status: c.status,
                    totalEvaluations: c.totalEvaluations,
                    evaluationIds: c.evaluationIds,
                    hasEvaluations: c.hasEvaluations,
                    isAdditionalCohort: c.isAdditionalCohort
                })),
                otherCohorts: otherCohorts.map(c => ({
                    name: c.cohortName,
                    status: c.status,
                    totalEvaluations: c.totalEvaluations,
                    evaluationIds: c.evaluationIds,
                    hasEvaluations: c.hasEvaluations,
                    isAdditionalCohort: c.isAdditionalCohort
                })),
                allCohorts: cohortsInfo.map(c => ({
                    name: c.cohortName,
                    status: c.status,
                    isActive: c.isActive,
                    isPast: c.isPast,
                    totalEvaluations: c.totalEvaluations,
                    evaluationIds: c.evaluationIds,
                    hasEvaluations: c.hasEvaluations,
                    isAdditionalCohort: c.isAdditionalCohort
                }))
            },
            note: 'Para obtener los datos completos con métricas, usa el endpoint /api/mentor-nps con autenticación'
        };

        res.status(200).json(response);

    } catch (err: any) {
        console.error('❌ [mentor-nps-test] Error:', err);
        res.status(500).json({
            error: 'Error en prueba de mentor-nps',
            details: err.message
        });
    }
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
        const { mentorId: mentorIdFromBody, startDate, endDate, includePast = true } = req.body;

        let mentorId: string | undefined = undefined;

        // Procesar mentorIdFromBody si existe
        if (mentorIdFromBody !== undefined && mentorIdFromBody !== null) {
            // Convertir a string y validar formato básico
            if (typeof mentorIdFromBody === 'string') {
                mentorId = mentorIdFromBody.trim();
            } else if (typeof mentorIdFromBody === 'number') {
                mentorId = mentorIdFromBody.toString();
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
            try {
                mentorId = await resolveMentorIdFromReq(req);
            } catch (error: any) {
                console.error('❌ [mentor-nps] Error resolviendo mentorId:', {
                    error: error.message,
                    email: (req as any).user4GeeksData?.email
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

        const COHORTS_DB_FOR_EVALS_SEARCH = process.env.NOTION_COHORTS_DATABASE_ID || process.env.NOTION_DATABASE_ID || '';
        if (!COHORTS_DB_FOR_EVALS_SEARCH) {
            return res.status(500).json({ error: 'Falta NOTION_COHORTS_DATABASE_ID o NOTION_DATABASE_ID en variables de entorno' });
        }

        // Estrategia mejorada: Buscar cohortes primero, luego evaluaciones
        let allPages: any[] = [];
        // Guardar las cohortes encontradas en la búsqueda inicial para usar después
        let allMentorCohortIdsFromSearch = new Set<string>();
        // Guardar las páginas de cohortes para evitar consultas posteriores
        let allMentorCohortPagesCache = new Map<string, any>();

        try {
            // Paso 1: Buscar todas las cohortes asignadas al mentor (T.A. y Teacher, directas y rollup)
            // OPTIMIZACIÓN: Paralelizar las 4 consultas para reducir tiempo de respuesta
            const allMentorCohortIds = new Set<string>();
            const allMentorCohortPages = new Map<string, any>();

            try {
                // Ejecutar las 4 consultas en paralelo para reducir latencia
                const [taDirectResult, taRollupResult, teacherDirectResult, teacherRollupResult] = await Promise.allSettled([
                    notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: {
                            property: 'T.A.',
                            relation: { contains: originalMentorId }
                        },
                        page_size: 100
                    }).catch(() => ({ results: [] })),
                    notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: {
                            property: 'T.A.',
                            rollup: {
                                any: {
                                    relation: { contains: originalMentorId }
                                }
                            }
                        },
                        page_size: 100
                    }).catch(() => ({ results: [] })),
                    notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: {
                            property: 'Teacher',
                            relation: { contains: originalMentorId }
                        },
                        page_size: 100
                    }).catch(() => ({ results: [] })),
                    notion.databases.query({
                        database_id: COHORTS_DB_FOR_EVALS_SEARCH,
                        filter: {
                            property: 'Teacher',
                            rollup: {
                                any: {
                                    relation: { contains: originalMentorId }
                                }
                            }
                        },
                        page_size: 100
                    }).catch(() => ({ results: [] }))
                ]);

                // Procesar resultados de todas las consultas
                const allResults = [
                    taDirectResult.status === 'fulfilled' ? taDirectResult.value.results || [] : [],
                    taRollupResult.status === 'fulfilled' ? taRollupResult.value.results || [] : [],
                    teacherDirectResult.status === 'fulfilled' ? teacherDirectResult.value.results || [] : [],
                    teacherRollupResult.status === 'fulfilled' ? teacherRollupResult.value.results || [] : []
                ].flat();

                // Guardar IDs y páginas para evitar consultas posteriores
                allResults.forEach((page: any) => {
                    allMentorCohortIds.add(page.id);
                    allMentorCohortIdsFromSearch.add(page.id);
                    allMentorCohortPages.set(page.id, page);
                    allMentorCohortPagesCache.set(page.id, page);
                });
            } catch (error: any) {
                // Continuar con el método tradicional si falla la búsqueda directa
            }

            // Paso 2: Si se encontraron cohortes, buscar evaluaciones para esas cohortes
            const foundCohortIdsInSearch = allMentorCohortIds.size > 0;
            if (foundCohortIdsInSearch) {
                const cohortIdsArray = Array.from(allMentorCohortIds);
                const BATCH_SIZE = 10;

                for (let i = 0; i < cohortIdsArray.length; i += BATCH_SIZE) {
                    const batch = cohortIdsArray.slice(i, i + BATCH_SIZE);
                    const cohortFilter: any = {
                        or: batch.map(cohortId => ({
                            property: 'Cohorts',
                            relation: { contains: cohortId }
                        }))
                    };

                    // Añadir filtros de fecha si se proporcionan
                    let finalFilter: any = cohortFilter;
                    if (startDate || endDate) {
                        const dateFilters: any[] = [];
                        if (startDate) {
                            dateFilters.push({
                                property: 'NPS ID',
                                title: { starts_with: startDate.substring(0, 7) }
                            });
                        }
                        if (endDate) {
                            dateFilters.push({
                                property: 'NPS ID',
                                title: { starts_with: endDate.substring(0, 7) }
                            });
                        }
                        finalFilter = { and: [cohortFilter, ...dateFilters] };
                    }

                    const batchResults = await notionQueryAll(NPS_DB, finalFilter);
                    allPages.push(...batchResults);
                }

                // Eliminar duplicados (una evaluación puede estar relacionada a múltiples cohortes)
                const uniquePageIds = new Set();
                allPages = allPages.filter(page => {
                    if (uniquePageIds.has(page.id)) {
                        return false;
                    }
                    uniquePageIds.add(page.id);
                    return true;
                });
            }

            // Las cohortes encontradas ya están guardadas en allMentorCohortIdsFromSearch

            // Paso 3: Fallback al método tradicional SOLO si no se encontraron evaluaciones
            // y NO se encontraron cohortes en la búsqueda inicial
            // Si se encontraron cohortes pero no evaluaciones, esas cohortes se incluirán más adelante
            // (especialmente cohortes activas sin evaluaciones aún)
            if (allPages.length === 0 && !foundCohortIdsInSearch) {
                const fallbackPages = new Set<string>();

                if (isAssistant) {
                    // Intentar T.A. directo
                    try {
                        const taDirectFilter: any = { property: 'T.A.', relation: { contains: originalMentorId } };
                        if (startDate || endDate) {
                            const andFilters: any[] = [taDirectFilter];
                            if (startDate) andFilters.push({ property: 'NPS ID', title: { starts_with: startDate.substring(0, 7) } });
                            if (endDate) andFilters.push({ property: 'NPS ID', title: { starts_with: endDate.substring(0, 7) } });
                            const results = await notionQueryAll(NPS_DB, { and: andFilters });
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        } else {
                            const results = await notionQueryAll(NPS_DB, taDirectFilter);
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        }
                    } catch (error: any) {
                        // Ignorar errores
                    }

                    // Intentar T.A. rollup
                    try {
                        const taRollupFilter: any = {
                            property: 'T.A.',
                            rollup: { any: { relation: { contains: originalMentorId } } }
                        };
                        if (startDate || endDate) {
                            const andFilters: any[] = [taRollupFilter];
                            if (startDate) andFilters.push({ property: 'NPS ID', title: { starts_with: startDate.substring(0, 7) } });
                            if (endDate) andFilters.push({ property: 'NPS ID', title: { starts_with: endDate.substring(0, 7) } });
                            const results = await notionQueryAll(NPS_DB, { and: andFilters });
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        } else {
                            const results = await notionQueryAll(NPS_DB, taRollupFilter);
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        }
                    } catch (error: any) {
                        // Ignorar errores
                    }
                } else {
                    // Intentar Teacher directo
                    try {
                        const teacherDirectFilter: any = { property: 'Teacher', relation: { contains: originalMentorId } };
                        if (startDate || endDate) {
                            const andFilters: any[] = [teacherDirectFilter];
                            if (startDate) andFilters.push({ property: 'NPS ID', title: { starts_with: startDate.substring(0, 7) } });
                            if (endDate) andFilters.push({ property: 'NPS ID', title: { starts_with: endDate.substring(0, 7) } });
                            const results = await notionQueryAll(NPS_DB, { and: andFilters });
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        } else {
                            const results = await notionQueryAll(NPS_DB, teacherDirectFilter);
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        }
                    } catch (error: any) {
                        // Ignorar errores
                    }

                    // Intentar Teacher rollup
                    try {
                        const teacherRollupFilter: any = {
                            property: 'Teacher',
                            rollup: { any: { relation: { contains: originalMentorId } } }
                        };
                        if (startDate || endDate) {
                            const andFilters: any[] = [teacherRollupFilter];
                            if (startDate) andFilters.push({ property: 'NPS ID', title: { starts_with: startDate.substring(0, 7) } });
                            if (endDate) andFilters.push({ property: 'NPS ID', title: { starts_with: endDate.substring(0, 7) } });
                            const results = await notionQueryAll(NPS_DB, { and: andFilters });
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        } else {
                            const results = await notionQueryAll(NPS_DB, teacherRollupFilter);
                            results.forEach((page: any) => fallbackPages.add(page.id));
                        }
                    } catch (error: any) {
                        // Ignorar errores
                    }
                }

                // Convertir Set a Array
                if (fallbackPages.size > 0) {
                    for (const pageId of fallbackPages) {
                        try {
                            const page = await notion.pages.retrieve({ page_id: pageId });
                            allPages.push(page);
                        } catch (error) {
                            // Continuar si no se puede obtener la página
                        }
                    }
                }
            }
        } catch (error: any) {
            return res.status(500).json({
                error: 'Error consultando Notion',
                details: error.message,
                databaseId: NPS_DB
            });
        }

        // Filtrar evaluaciones que realmente corresponden al mentor actual
        // IMPORTANTE: Verificar tanto TA como Teacher en cada evaluación, ya que el mentor
        // puede ser TA en unas evaluaciones y Teacher en otras de la misma cohorte
        const pages: any[] = [];
        const skippedEvaluations: any[] = [];

        for (const page of allPages) {
            const props = (page as any).properties || {};
            const npsId = props['NPS ID']?.title?.[0]?.plain_text || 'sin ID';

            // Verificar si está como TA
            const taRelation = props['T.A.']?.relation || props['T.A.']?.rollup?.array?.[0]?.relation || [];
            const taIds = taRelation.map((t: any) => t.id);
            const normalizedTaIds = taIds.map((id: string) => id.replace(/-/g, ''));
            const isMentorTA = normalizedTaIds.includes(normalizedMentorId);

            // Verificar si está como Teacher
            const teacherRelation = props['Teacher']?.relation || props['Teacher']?.rollup?.array?.[0]?.relation || [];
            const teacherIds = teacherRelation.map((t: any) => t.id);
            const normalizedTeacherIds = teacherIds.map((id: string) => id.replace(/-/g, ''));

            // Si está como TA, incluirlo
            if (isMentorTA) {
                pages.push(page);
            }
            // Si está como Teacher, verificar responsabilidad
            else if (normalizedTeacherIds.includes(normalizedMentorId)) {
                const mentorChangeDate = props['Mentor Change Date']?.rollup?.array?.[0]?.date?.start || null;

                // Extraer fecha de evaluación
                const evaluationDate = props['Date of Creation']?.date?.start ||
                    props['Date of Creation']?.rich_text?.[0]?.plain_text ||
                    page.created_time ||
                    props['NPS ID']?.title?.[0]?.plain_text || '';

                // Determinar si el mentor actual es responsable de esta evaluación
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
                        npsId,
                        reason: responsibility.reason,
                        evaluationDate,
                        mentorChangeDate,
                        teacherIds
                    });
                }
            } else {
                // No está ni como TA ni como Teacher
                skippedEvaluations.push({
                    npsId,
                    reason: 'Mentor no está como TA ni como Teacher en la evaluación',
                    evaluationDate: props['Date of Creation']?.date?.start || page.created_time,
                    mentorChangeDate: null,
                    teacherIds
                });
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
        // Primero, obtener cohortes de las evaluaciones NPS
        const cohortIdsFromEvaluations = Array.from(byCohort.keys());

        // También buscar cohortes asignadas directamente al mentor en la base de datos de cohortes
        // Usar la misma base de datos que en la búsqueda inicial para consistencia
        const COHORTS_DB_FOR_INFO = COHORTS_DB_FOR_EVALS_SEARCH || process.env.NOTION_DATABASE_ID || '';
        let additionalCohortIds: string[] = [];

        // Combinar cohortes encontradas en búsqueda inicial con las que se encuentran ahora
        // Esto asegura que todas las cohortes del mentor se incluyan, incluso si no tienen evaluaciones
        const allKnownMentorCohortIds = new Set<string>();

        // Agregar cohortes de la búsqueda inicial (si existen)
        allMentorCohortIdsFromSearch.forEach(id => allKnownMentorCohortIds.add(id));

        // OPTIMIZACIÓN: Usar las cohortes ya encontradas en lugar de consultarlas de nuevo
        // Solo buscar información adicional si hay cohortes que no están en el cache
        if (COHORTS_DB_FOR_INFO) {
            try {
                // Obtener IDs de cohortes del cache y de evaluaciones
                const cachedCohortIds = Array.from(allMentorCohortPagesCache.keys());
                const missingCohortIds = Array.from(allKnownMentorCohortIds).filter(id => !allMentorCohortPagesCache.has(id));

                // Si hay cohortes en el cache, usarlas directamente
                if (cachedCohortIds.length > 0) {
                    cachedCohortIds.forEach(id => allKnownMentorCohortIds.add(id));
                }

                // Solo buscar información adicional para cohortes que no están en el cache
                if (missingCohortIds.length > 0) {
                    // Obtener información de las cohortes faltantes en paralelo
                    const missingCohortPages = await Promise.all(
                        missingCohortIds.map(async (id) => {
                            try {
                                const page = await notion.pages.retrieve({ page_id: id });
                                allMentorCohortPagesCache.set(id, page);
                                return page;
                            } catch (error) {
                                return null;
                            }
                        })
                    );
                }
            } catch (error: any) {
                // Ignorar errores
            }
        }

        // Agregar todas las cohortes conocidas del mentor que no están en las evaluaciones
        additionalCohortIds = Array.from(allKnownMentorCohortIds).filter(id => !cohortIdsFromEvaluations.includes(id));

        // Combinar todas las cohortes
        const allCohortIds = [...cohortIdsFromEvaluations, ...additionalCohortIds];

        // OPTIMIZACIÓN: Usar cache cuando sea posible, solo consultar las faltantes
        const cohortPagesToFetch = allCohortIds.filter(id => !allMentorCohortPagesCache.has(id));
        const cohortPagesFromCache = allCohortIds
            .filter(id => allMentorCohortPagesCache.has(id))
            .map(id => allMentorCohortPagesCache.get(id)!);

        // Solo consultar las cohortes que no están en el cache
        const cohortPagesFetched = cohortPagesToFetch.length > 0 ? await Promise.all(
            cohortPagesToFetch.map(async (id) => {
                try {
                    const page = await notion.pages.retrieve({ page_id: id });
                    allMentorCohortPagesCache.set(id, page);
                    return page;
                } catch (error) {
                    return null;
                }
            })
        ) : [];

        // Combinar cache y consultas
        const cohortPages = [...cohortPagesFromCache, ...cohortPagesFetched];

        // Estados permitidos para mostrar NPS
        const allowedStatuses = ['Active', 'Final Project', 'Finished'];

        // Procesar resultados
        const resultActive: any[] = [];
        const resultPast: any[] = [];

        for (const cohortPage of cohortPages) {
            if (!cohortPage) continue;

            const cohortId = cohortPage.id;
            const cohortData = byCohort.get(cohortId);

            // Obtener estado de la cohorte - intentar diferentes nombres de campo
            const statusProp1 = (cohortPage as any).properties?.['Cohort Status ']?.select?.name;
            const statusProp2 = (cohortPage as any).properties?.['Cohort Status']?.select?.name;
            const statusProp3 = (cohortPage as any).properties?.Status?.select?.name;
            const status = statusProp1 || statusProp2 || statusProp3 || '';

            const cohortName = (cohortPage as any).properties?.Cohort?.title?.[0]?.plain_text ||
                (cohortPage as any).properties?.Title?.title?.[0]?.plain_text ||
                'Cohorte sin nombre';

            // Solo procesar cohortes con estados permitidos
            if (!allowedStatuses.includes(status)) {
                continue;
            }

            // Si no hay datos de evaluaciones, crear estructura vacía para cohortes activas
            const items = cohortData?.items || [];

            // Si es una cohorte activa sin evaluaciones, aún así mostrarla
            const isActive = status === 'Active' || status === 'Final Project';
            if (!cohortData && !isActive) {
                continue; // Solo omitir cohortes finalizadas sin evaluaciones
            }

            // Calcular métricas - incluir todos los scores válidos (no solo > 0)
            const teacherScores = items.map(i => i.teacherScore).filter(s => s !== null && s !== undefined && s >= 0);
            const cohortScores = items.map(i => i.cohortScore).filter(s => s !== null && s !== undefined && s >= 0);
            const taScores = items.map(i => i.taScores).filter(s => s !== null && s !== undefined && s >= 0);
            const participations = items.map(i => i.participation).filter(p => p !== null && p !== undefined && p >= 0);

            const teacherMetrics = computeNps(teacherScores);
            const cohortMetrics = computeNps(cohortScores);
            const taMetrics = computeNps(taScores);

            // Determinar si es pasada (ya se determinó isActive arriba)
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
                teacherAverage: overall.avg,
                totalEvaluations: overall.count,
                scoreType: isAssistant ? 'TA Score' : 'Teacher Score'
            },
            totalCohorts: resultActive.length + resultPast.length,
            totalEvaluations: validationStats.assignedEvaluations,
            mentorId: originalMentorId,
            mentorName,
            userRole: isAssistant ? 'assistant' : 'teacher',
            visualizationData: safeVisualizationData,
            totalComments: Array.from(commentsMap.values()).flat().length,
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
            const hasReferences = allEvaluations.some((evaluation: any) => evaluation.hasOurMentorId);
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

/**
 * Helper: Obtiene el nombre de un estudiante desde Notion usando su ID
 */
async function getStudentNameFromNotion(studentId: string): Promise<string> {
    try {
        const studentPage = await notion.pages.retrieve({
            page_id: studentId
        });

        // Debug: Ver la estructura real de la página del estudiante
        const properties = (studentPage as any).properties;
        const propertyKeys = Object.keys(properties || {});

        console.log(`🔍 [getStudentNameFromNotion] Estructura de estudiante ${studentId}:`, {
            propertyKeys,
            sampleProperties: propertyKeys.slice(0, 5).reduce((acc: any, key: string) => {
                acc[key] = {
                    type: properties[key]?.type,
                    hasTitle: !!properties[key]?.title,
                    hasRichText: !!properties[key]?.rich_text,
                    titleValue: properties[key]?.title?.[0]?.plain_text || null
                };
                return acc;
            }, {})
        });

        // El nombre del estudiante está en el campo "Student"
        if (properties?.Student) {
            const studentProp = properties.Student;

            // Puede ser un campo title
            if (studentProp?.type === 'title' && studentProp?.title?.[0]?.plain_text) {
                const name = studentProp.title[0].plain_text.trim();
                if (name) {
                    return name;
                }
            }

            // Puede ser un campo rich_text
            if (studentProp?.type === 'rich_text' && studentProp?.rich_text?.[0]?.plain_text) {
                const name = studentProp.rich_text[0].plain_text.trim();
                if (name) {
                    return name;
                }
            }

            // Puede ser un campo formula que retorna texto
            if (studentProp?.type === 'formula' && studentProp?.formula?.string) {
                const name = studentProp.formula.string.trim();
                if (name) {
                    return name;
                }
            }
        }

        // Fallback: buscar en campos title (nombre principal de la página)
        for (const key of propertyKeys) {
            const prop = properties[key];
            if (prop?.type === 'title' && prop?.title?.[0]?.plain_text) {
                const name = prop.title[0].plain_text.trim();
                if (name) {
                    return name;
                }
            }
        }

        // Si no se encuentra, retornar desconocido
        console.log(`⚠️ [getStudentNameFromNotion] No se pudo extraer nombre del estudiante ${studentId}`);
        return 'Estudiante desconocido';
    } catch (error: any) {
        console.error(`⚠️ [getStudentNameFromNotion] Error obteniendo estudiante ${studentId}:`, error.message);
        return 'Estudiante desconocido';
    }
}

/**
 * Helper: Obtiene nombres de estudiantes en batch para evitar consultas duplicadas
 */
async function getStudentNamesBatch(studentIds: string[]): Promise<Map<string, string>> {
    const studentNamesMap = new Map<string, string>();
    const uniqueIds = [...new Set(studentIds)];

    // Hacer todas las consultas en paralelo
    const promises = uniqueIds.map(async (id) => {
        const name = await getStudentNameFromNotion(id);
        return { id, name };
    });

    const results = await Promise.allSettled(promises);

    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            studentNamesMap.set(result.value.id, result.value.name);
        } else {
            studentNamesMap.set(uniqueIds[index], 'Estudiante desconocido');
        }
    });

    return studentNamesMap;
}

/**
 * Helper: Mapea el tipo de mentoría de Notion al tipo del sistema
 */
function mapMentorshipTypeFromNotion(notionType: string | null | undefined): 'Mock interview' | 'Mentoría' {
    if (!notionType) return 'Mentoría';

    const type = notionType.toLowerCase();
    if (type === 'mock_interview') {
        return 'Mock interview';
    }
    // mentorship, geek_force, geekForce → Mentoría
    return 'Mentoría';
}

/**
 * Helper: Consulta cancelaciones desde Notion con filtros
 */
async function fetchCancellationsFromNotion(
    mentorName: string,
    currentPeriod: { start: Date; end: Date },
    previousPeriod: { start: Date; end: Date }
): Promise<any[]> {
    const CANCELLATIONS_DB = process.env.NOTION_CANCELLATIONS_DATABASE_ID || '';

    if (!CANCELLATIONS_DB) {
        throw new Error('NOTION_CANCELLATIONS_DATABASE_ID no está configurado en variables de entorno');
    }

    // Extraer apellido del nombre completo (última palabra)
    const nameParts = mentorName.trim().split(/\s+/);
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : mentorName;

    // Formatear fechas para Notion (ISO string sin tiempo para dates)
    const formatDateForNotion = (date: Date): string => {
        return date.toISOString().split('T')[0];
    };

    // Crear filtros para cada periodo
    // Nota: Los campos select en Notion solo soportan 'equals' exacto
    // Usamos OR para buscar por nombre completo o apellido
    const mentorshipTypeFilter = {
        or: [
            { property: 'Tipo de mentoría', select: { equals: 'mock_interview' } },
            { property: 'Tipo de mentoría', select: { equals: 'mentorship' } },
            { property: 'Tipo de mentoría', select: { equals: 'geek_force' } },
            { property: 'Tipo de mentoría', select: { equals: 'geekForce' } }
        ]
    };

    const currentPeriodFilter = {
        and: [
            {
                or: [
                    { property: 'Mentor/a', select: { equals: mentorName } },
                    { property: 'Mentor/a', select: { equals: lastName } }
                ]
            },
            {
                property: 'Fecha y hora de mentoría',
                date: {
                    on_or_after: formatDateForNotion(currentPeriod.start)
                }
            },
            {
                property: 'Fecha y hora de mentoría',
                date: {
                    on_or_before: formatDateForNotion(currentPeriod.end)
                }
            },
            mentorshipTypeFilter
        ]
    };

    const previousPeriodFilter = {
        and: [
            {
                or: [
                    { property: 'Mentor/a', select: { equals: mentorName } },
                    { property: 'Mentor/a', select: { equals: lastName } }
                ]
            },
            {
                property: 'Fecha y hora de mentoría',
                date: {
                    on_or_after: formatDateForNotion(previousPeriod.start)
                }
            },
            {
                property: 'Fecha y hora de mentoría',
                date: {
                    on_or_before: formatDateForNotion(previousPeriod.end)
                }
            },
            mentorshipTypeFilter
        ]
    };

    // Consultar ambos periodos en paralelo
    const allResults: any[] = [];

    try {
        const [currentResults, previousResults] = await Promise.all([
            notionQueryAll(CANCELLATIONS_DB, currentPeriodFilter).catch(() => []),
            notionQueryAll(CANCELLATIONS_DB, previousPeriodFilter).catch(() => [])
        ]);

        allResults.push(...currentResults, ...previousResults);
    } catch (error: any) {
        console.error('❌ [fetchCancellationsFromNotion] Error consultando Notion:', error.message);
        throw error;
    }

    // Eliminar duplicados por ID
    const uniqueResults = Array.from(
        new Map(allResults.map(item => [item.id, item])).values()
    );

    return uniqueResults;
}

/**
 * Helper: Busca un estudiante en Notion por nombre
 */
async function findStudentIdByName(studentName: string): Promise<string | null> {
    try {
        const STUDENTS_DB = process.env.NOTION_STD_DATABASE_ID || process.env.NOTION_STUDENTS_DATABASE_ID || '';

        if (!STUDENTS_DB) {
            console.error('⚠️ [findStudentIdByName] No se encontró NOTION_STD_DATABASE_ID o NOTION_STUDENTS_DATABASE_ID');
            return null;
        }

        // Buscar por campo "Student" que contenga el nombre
        const response = await notion.databases.query({
            database_id: STUDENTS_DB,
            filter: {
                or: [
                    {
                        property: 'Student',
                        title: {
                            contains: studentName
                        }
                    },
                    {
                        property: 'Name',
                        title: {
                            contains: studentName
                        }
                    },
                    {
                        property: 'Nombre',
                        title: {
                            contains: studentName
                        }
                    }
                ]
            }
        });

        if (response.results && response.results.length > 0) {
            // Retornar el primer resultado encontrado
            return response.results[0].id;
        }

        return null;
    } catch (error: any) {
        console.error('❌ [findStudentIdByName] Error buscando estudiante:', error.message);
        return null;
    }
}

/**
 * Helper: Busca una cancelación existente en Notion por fecha de mentoría y estudiante
 */
async function findExistingCancellation(mentorshipDate: Date, studentId: string): Promise<string | null> {
    try {
        const CANCELLATIONS_DB = process.env.NOTION_CANCELLATIONS_DATABASE_ID || '';

        if (!CANCELLATIONS_DB) {
            throw new Error('NOTION_CANCELLATIONS_DATABASE_ID no está configurado');
        }

        // Formatear fecha para Notion (solo fecha, sin hora)
        const formatDateForNotion = (date: Date): string => {
            return date.toISOString().split('T')[0];
        };

        const dateStr = formatDateForNotion(mentorshipDate);

        // Buscar cancelación por fecha de mentoría y estudiante
        const response = await notion.databases.query({
            database_id: CANCELLATIONS_DB,
            filter: {
                and: [
                    {
                        property: 'Fecha y hora de mentoría',
                        date: {
                            equals: dateStr
                        }
                    },
                    {
                        property: 'Estudiante',
                        relation: {
                            contains: studentId
                        }
                    }
                ]
            }
        });

        if (response.results && response.results.length > 0) {
            return response.results[0].id;
        }

        return null;
    } catch (error: any) {
        console.error('❌ [findExistingCancellation] Error buscando cancelación:', error.message);
        return null;
    }
}

/**
 * Helper: Formatea la información de la mentorship en texto estructurado para las notas
 */
function formatMentorshipNotes(mentorshipData: {
    student: string;
    startTime: string;
    endTime: string;
    duration: number;
    status: string;
    service: string;
}): string {
    const formatDateTime = (isoString: string): string => {
        if (!isoString) return 'No especificada';
        try {
            const date = new Date(isoString);
            return date.toLocaleString('es-ES', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return isoString;
        }
    };

    const notes = [
        `Nombre de alumno: ${mentorshipData.student}`,
        `Hora de comienzo: ${formatDateTime(mentorshipData.startTime)}`,
        `Hora de finalización: ${mentorshipData.endTime ? formatDateTime(mentorshipData.endTime) : 'No finalizada'}`,
        `Duración: ${mentorshipData.duration} minutos`,
        `Estado: ${mentorshipData.status}`,
        `Servicio: ${mentorshipData.service}`
    ].join('\n');

    return notes;
}

/**
 * Helper: Mapea el tipo de servicio del sistema a valores de Notion
 */
function mapServiceToNotionType(service: 'Mock interview' | 'Mentoría'): string {
    if (service === 'Mock interview') {
        return 'mock_interview';
    }
    // Por defecto, usar "mentorship" para Mentoría
    // Nota: Si hay lógica de negocio para distinguir entre mentorship, geek_force, geekForce, agregarla aquí
    return 'mentorship';
}

/**
 * Helper: Actualiza una cancelación existente marcando "Ask for revision"
 * Nota: No modifica las notas ni el motivo existentes, solo marca el checkbox
 */
async function updateCancellationReviewRequest(pageId: string): Promise<void> {
    try {
        await notion.pages.update({
            page_id: pageId,
            properties: {
                'Ask for revision': {
                    checkbox: true
                }
            }
        });
    } catch (error: any) {
        console.error('❌ [updateCancellationReviewRequest] Error actualizando cancelación:', error.message);
        throw error;
    }
}

/**
 * Helper: Crea una nueva cancelación en Notion para solicitud de revisión
 */
async function createCancellationForReview(
    mentorshipData: {
        studentId: string | null;
        startTime: string;
        endTime: string;
        duration: number;
        status: string;
        service: string;
        student: string;
    },
    mentorName: string
): Promise<string> {
    try {
        const CANCELLATIONS_DB = process.env.NOTION_CANCELLATIONS_DATABASE_ID || '';

        if (!CANCELLATIONS_DB) {
            throw new Error('NOTION_CANCELLATIONS_DATABASE_ID no está configurado');
        }

        // Formatear notas
        const notes = formatMentorshipNotes({
            student: mentorshipData.student,
            startTime: mentorshipData.startTime,
            endTime: mentorshipData.endTime,
            duration: mentorshipData.duration,
            status: mentorshipData.status,
            service: mentorshipData.service
        });

        // Formatear fecha de mentoría (solo fecha para Notion)
        const mentorshipDate = new Date(mentorshipData.startTime);
        const mentorshipDateStr = mentorshipDate.toISOString().split('T')[0];

        // Fecha actual para cancelación
        const cancellationDate = new Date();
        const cancellationDateStr = cancellationDate.toISOString();

        // Mapear tipo de servicio
        const serviceType = mapServiceToNotionType(mentorshipData.service as 'Mock interview' | 'Mentoría');

        // Construir propiedades base
        const properties: any = {
            'Fecha y hora de mentoría': {
                date: {
                    start: mentorshipDateStr
                }
            },
            'Fecha y hora de cancelación': {
                date: {
                    start: cancellationDateStr
                }
            },
            'Mentor/a': {
                select: {
                    name: mentorName
                }
            },
            'Motivo de reprogramación': {
                select: {
                    name: 'Solicitud de revisión'
                }
            },
            'Tipo de mentoría': {
                select: {
                    name: serviceType
                }
            },
            'Ask for revision': {
                checkbox: true
            },
            'Suplido con otro alumno': {
                checkbox: false
            },
            'Notas': {
                rich_text: [{
                    text: {
                        content: notes
                    }
                }]
            }
        };

        // Solo agregar relación de estudiante si tenemos studentId
        if (mentorshipData.studentId) {
            properties['Estudiante'] = {
                relation: [{
                    id: mentorshipData.studentId
                }]
            };
        }

        const response = await notion.pages.create({
            parent: {
                database_id: CANCELLATIONS_DB
            },
            properties
        });

        return response.id;
    } catch (error: any) {
        console.error('❌ [createCancellationForReview] Error creando cancelación:', error.message);
        throw error;
    }
}

// Endpoint para obtener las mentorías del mentor autenticado
app.get('/api/mentor/my-mentorships', authMiddleware, async (req, res) => {
    try {
        // Obtener y validar query parameter periodType
        const periodType = (req.query.periodType as string) || 'academic';
        if (periodType !== 'academic' && periodType !== 'monthly') {
            return res.status(400).json({
                error: 'periodType debe ser "academic" o "monthly"'
            });
        }

        // Obtener token del header Authorization (el middleware ya validó que existe)
        const authHeader = req.headers['authorization'] as string;
        const token = authHeader.split(' ')[1];

        // Obtener Academy ID (por defecto 6, según el plan)
        const academyId = process.env.API_ACADEMY || '6';

        // Obtener nombre del mentor
        const userData = (req as any).user4GeeksData;
        const mentorName = userData?.first_name && userData?.last_name
            ? `${userData.first_name} ${userData.last_name}`
            : userData?.username || 'Mentor';

        // Obtener mentorías del API
        const sessions = await fetchMentorSessions(token, academyId);

        // Calcular fechas de periodos según el tipo seleccionado
        const currentPeriod = periodType === 'monthly'
            ? getCurrentMonthlyPeriodDates()
            : getCurrentPeriodDates();
        const previousPeriod = periodType === 'monthly'
            ? getPreviousMonthlyPeriodDates()
            : getPreviousPeriodDates();

        // Procesar mentorías
        const processedMentorships: ProcessedMentorship[] = [];

        sessions.forEach((session: any) => {
            // Obtener fecha de inicio (requerida)
            const startTime = getMentorshipStartTime(session);
            if (!startTime) {
                // Excluir mentorías sin fecha de inicio
                return;
            }

            // Determinar a qué periodo pertenece
            let period: 'current' | 'previous' | null = null;
            if (startTime >= currentPeriod.start && startTime <= currentPeriod.end) {
                period = 'current';
            } else if (startTime >= previousPeriod.start && startTime <= previousPeriod.end) {
                period = 'previous';
            } else {
                // Fuera de los periodos de interés, excluir
                return;
            }

            // Obtener fecha de fin
            const endTime = getMentorshipEndTime(session);

            // Calcular duración
            let duration = 0;
            if (endTime) {
                duration = calculateDuration(startTime, endTime);
            }

            // Determinar tipo de servicio usando la función helper
            const serviceName = getServiceName(session);
            const service = determineServiceType(serviceName);

            // Calcular status
            const status = calculateMentorshipStatus(session);

            // Determinar canRequestReview (false si se paga, true si no)
            const canRequestReview = status === 'No corresponde' || status === 'No realizada';

            // Obtener nombre del estudiante
            const student = getStudentName(session);

            // Agregar mentoría procesada
            processedMentorships.push({
                id: String(session.id),
                student,
                service,
                startTime: startTime.toISOString(),
                endTime: endTime ? endTime.toISOString() : '',
                duration,
                status,
                canRequestReview,
                period,
            });
        });

        // Generar resúmenes mensuales
        const monthlySummaries = generateMonthlySummaries(
            processedMentorships,
            currentPeriod,
            previousPeriod
        );

        // Retornar respuesta en el formato esperado
        res.status(200).json({
            mentorName,
            mentorships: processedMentorships.map((m) => ({
                id: m.id,
                student: m.student,
                service: m.service,
                startTime: m.startTime,
                endTime: m.endTime,
                duration: m.duration,
                status: m.status,
                canRequestReview: m.canRequestReview,
            })),
            monthlySummaries,
        });
    } catch (error: any) {
        console.error('❌ [mentor/my-mentorships] Error:', {
            error: error.message,
            stack: error.stack,
        });
        res.status(500).json({
            error: 'Error al obtener mentorías',
            details: error.message,
        });
    }
});

// Endpoint para obtener las mentorías canceladas del mentor autenticado
app.get('/api/mentor/cancelled-mentorships', authMiddleware, async (req, res) => {
    try {
        // Obtener y validar query parameter periodType
        const periodType = (req.query.periodType as string) || 'academic';
        if (periodType !== 'academic' && periodType !== 'monthly') {
            return res.status(400).json({
                error: 'periodType debe ser "academic" o "monthly"'
            });
        }

        // Obtener nombre del mentor
        const userData = (req as any).user4GeeksData;
        const mentorName = userData?.first_name && userData?.last_name
            ? `${userData.first_name} ${userData.last_name}`
            : userData?.username || 'Mentor';

        // Calcular fechas de periodos según el tipo seleccionado
        const currentPeriod = periodType === 'monthly'
            ? getCurrentMonthlyPeriodDates()
            : getCurrentPeriodDates();
        const previousPeriod = periodType === 'monthly'
            ? getPreviousMonthlyPeriodDates()
            : getPreviousPeriodDates();

        // Obtener cancelaciones desde Notion
        const cancellations = await fetchCancellationsFromNotion(
            mentorName,
            currentPeriod,
            previousPeriod
        );

        // Extraer todos los IDs de estudiantes únicos
        const studentIds: string[] = [];
        cancellations.forEach((cancellation: any) => {
            const studentRelation = cancellation.properties?.['Estudiante']?.relation;
            if (studentRelation && Array.isArray(studentRelation) && studentRelation.length > 0) {
                studentIds.push(studentRelation[0].id);
            }
        });

        // Obtener nombres de estudiantes en batch
        const studentNamesMap = await getStudentNamesBatch(studentIds);

        // Procesar cancelaciones
        const processedCancellations: any[] = [];

        // Preparar nombres para validación (nombre completo y apellido)
        const nameParts = mentorName.trim().split(/\s+/);
        const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : mentorName;
        const mentorNamesForValidation = [mentorName, lastName];

        cancellations.forEach((cancellation: any) => {
            const properties = cancellation.properties || {};

            // Validar que la cancelación pertenezca al mentor (validación adicional de seguridad)
            const cancellationMentor = properties['Mentor/a']?.select?.name;
            if (!cancellationMentor || !mentorNamesForValidation.includes(cancellationMentor)) {
                console.log(`⚠️ [cancelled-mentorships] Cancelación ${cancellation.id} excluida: no pertenece al mentor ${mentorName} (mentor en cancelación: ${cancellationMentor || 'sin mentor'})`);
                return;
            }

            // Extraer fecha de mentoría
            const mentorshipDateProp = properties['Fecha y hora de mentoría']?.date;
            if (!mentorshipDateProp?.start) {
                console.log(`⚠️ [cancelled-mentorships] Cancelación ${cancellation.id} excluida: sin fecha de mentoría`);
                return;
            }

            const mentorshipDate = new Date(mentorshipDateProp.start);

            // Determinar a qué periodo pertenece
            let period: 'current' | 'previous' | null = null;
            if (mentorshipDate >= currentPeriod.start && mentorshipDate <= currentPeriod.end) {
                period = 'current';
            } else if (mentorshipDate >= previousPeriod.start && mentorshipDate <= previousPeriod.end) {
                period = 'previous';
            } else {
                // Fuera de los periodos de interés, excluir
                return;
            }

            // Extraer estudiante
            const studentRelation = properties['Estudiante']?.relation;
            const studentId = studentRelation && Array.isArray(studentRelation) && studentRelation.length > 0
                ? studentRelation[0].id
                : null;
            const student = studentId ? studentNamesMap.get(studentId) || 'Estudiante desconocido' : 'Estudiante desconocido';

            // Extraer tipo de mentoría
            const mentorshipType = properties['Tipo de mentoría']?.select?.name || null;
            const service = mapMentorshipTypeFromNotion(mentorshipType);

            // Extraer fecha de cancelación
            const cancellationDateProp = properties['Fecha y hora de cancelación']?.date;
            const cancellationDate = cancellationDateProp?.start
                ? new Date(cancellationDateProp.start).toISOString()
                : '';

            // Extraer motivo de reprogramación
            const cancellationReason = properties['Motivo de reprogramación']?.select?.name || '';

            // Extraer notas
            const notesProp = properties['Notas']?.rich_text;
            const notes = notesProp && Array.isArray(notesProp) && notesProp.length > 0
                ? notesProp.map((text: any) => text.plain_text || '').join(' ')
                : '';

            // Extraer status (campo fórmula)
            const statusProp = properties['Status'];
            let status: 'A pagar' | 'No corresponde' = 'No corresponde';

            // El campo Status es una fórmula, puede venir como formula, rich_text, o select
            if (statusProp?.formula?.string) {
                const statusValue = statusProp.formula.string;
                status = statusValue === 'A pagar' ? 'A pagar' : 'No corresponde';
            } else if (statusProp?.formula?.boolean !== undefined) {
                status = statusProp.formula.boolean ? 'A pagar' : 'No corresponde';
            } else if (statusProp?.rich_text?.[0]?.plain_text) {
                const statusValue = statusProp.rich_text[0].plain_text;
                status = statusValue === 'A pagar' ? 'A pagar' : 'No corresponde';
            } else if (statusProp?.select?.name) {
                const statusValue = statusProp.select.name;
                status = statusValue === 'A pagar' ? 'A pagar' : 'No corresponde';
            }

            // Determinar canRequestReview (false si se paga, true si no)
            const canRequestReview = status === 'No corresponde';

            // Agregar cancelación procesada
            processedCancellations.push({
                id: cancellation.id,
                student,
                service,
                cancellationDate,
                mentorshipDate: mentorshipDate.toISOString(),
                cancellationReason,
                notes,
                status,
                period,
                canRequestReview,
            });
        });

        // Retornar respuesta en el formato esperado
        res.status(200).json({
            mentorName,
            cancelledMentorships: processedCancellations,
        });
    } catch (error: any) {
        console.error('❌ [mentor/cancelled-mentorships] Error:', {
            error: error.message,
            stack: error.stack,
        });
        res.status(500).json({
            error: 'Error al obtener mentorías canceladas',
            details: error.message,
        });
    }
});

// Endpoint para solicitar revisión de una mentoría
app.post('/api/mentor/request-review', authMiddleware, async (req, res) => {
    try {
        const {
            cancellationId,
            mentorshipId,
            student,
            studentId,
            service,
            startTime,
            endTime,
            duration,
            status
        } = req.body;

        // Validaciones
        if (!mentorshipId) {
            return res.status(400).json({ error: 'mentorshipId es requerido' });
        }
        if (!student) {
            return res.status(400).json({ error: 'student es requerido' });
        }
        if (!startTime) {
            return res.status(400).json({ error: 'startTime es requerido' });
        }
        if (!service) {
            return res.status(400).json({ error: 'service es requerido' });
        }

        // Normalizar el servicio (case-insensitive y manejar variaciones)
        const normalizedService = service.trim();
        const serviceLower = normalizedService.toLowerCase();

        let finalService: 'Mock interview' | 'Mentoría';
        if (serviceLower === 'mock interview' || serviceLower === 'mock_interview') {
            finalService = 'Mock interview';
        } else if (serviceLower === 'mentoría' || serviceLower === 'mentoria' || serviceLower === 'mentorship') {
            finalService = 'Mentoría';
        } else {
            return res.status(400).json({
                error: 'service debe ser "Mock interview" o "Mentoría"',
                received: service
            });
        }

        // Validar formato de fecha ISO
        if (!isISODateString(startTime)) {
            return res.status(400).json({ error: 'startTime debe ser una fecha ISO válida' });
        }
        if (endTime && !isISODateString(endTime)) {
            return res.status(400).json({ error: 'endTime debe ser una fecha ISO válida' });
        }

        // Obtener nombre del mentor
        const userData = (req as any).user4GeeksData;
        const mentorName = userData?.first_name && userData?.last_name
            ? `${userData.first_name} ${userData.last_name}`
            : userData?.username || 'Mentor';

        // Buscar cancelación existente y obtener studentId
        let cancellationPageId: string | null = null;
        let wasCreated = false;
        let finalStudentId: string | null = null;

        if (cancellationId) {
            // Si se envía cancellationId, obtener la página directamente y extraer studentId
            try {
                const cancellationPage = await notion.pages.retrieve({ page_id: cancellationId });
                cancellationPageId = cancellationId;

                // Extraer studentId de la cancelación existente
                const properties = (cancellationPage as any).properties || {};
                const studentRelation = properties['Estudiante']?.relation;
                if (studentRelation && Array.isArray(studentRelation) && studentRelation.length > 0) {
                    finalStudentId = studentRelation[0].id;
                    console.log(`✅ [request-review] StudentId extraído de cancelación existente: ${finalStudentId}`);
                }
            } catch (error: any) {
                if (error.code === 'object_not_found') {
                    // La página no existe, continuar para crear nueva
                    console.log(`⚠️ [request-review] Cancelación ${cancellationId} no encontrada, se creará nueva`);
                } else {
                    throw error;
                }
            }
        }

        // Si no se obtuvo studentId de la cancelación, intentar obtenerlo de otras fuentes
        if (!finalStudentId) {
            if (studentId) {
                finalStudentId = studentId;
            } else {
                // Buscar estudiante por nombre (solo si no tenemos cancellationId)
                if (!cancellationId) {
                    finalStudentId = await findStudentIdByName(student);
                    if (!finalStudentId) {
                        // Si no se encuentra el estudiante, continuar sin studentId
                        // El nombre del estudiante estará en las notas
                        console.log(`⚠️ [request-review] Estudiante "${student}" no encontrado en Notion. Se creará cancelación sin relación de estudiante.`);
                    }
                } else {
                    // Si tenemos cancellationId pero no pudimos extraer studentId, continuar sin él
                    // El nombre del estudiante estará en las notas
                    console.log(`⚠️ [request-review] Cancelación ${cancellationId} no tiene estudiante asociado. Se actualizará sin relación de estudiante.`);
                }
            }
        }

        // Si no se encontró cancelación por ID, buscar por fecha y estudiante (solo si tenemos studentId)
        if (!cancellationPageId && finalStudentId) {
            const mentorshipDate = new Date(startTime);
            cancellationPageId = await findExistingCancellation(mentorshipDate, finalStudentId);
        }

        // Actualizar o crear cancelación
        if (cancellationPageId) {
            // Actualizar cancelación existente (solo checkbox, sin modificar notas ni motivo)
            await updateCancellationReviewRequest(cancellationPageId);
            console.log(`✅ [request-review] Cancelación ${cancellationPageId} actualizada (solo checkbox)`);
        } else {
            // Crear nueva cancelación con toda la información incluyendo notas
            const notes = formatMentorshipNotes({
                student,
                startTime,
                endTime: endTime || '',
                duration: duration || 0,
                status: status || '',
                service: finalService
            });

            cancellationPageId = await createCancellationForReview({
                studentId: finalStudentId,
                startTime,
                endTime: endTime || '',
                duration: duration || 0,
                status: status || '',
                service: finalService,
                student
            }, mentorName);
            wasCreated = true;
            console.log(`✅ [request-review] Nueva cancelación ${cancellationPageId} creada con toda la información`);
        }

        // Retornar respuesta
        res.status(200).json({
            success: true,
            message: 'Solicitud de revisión registrada correctamente',
            cancellationId: cancellationPageId,
            created: wasCreated
        });
    } catch (error: any) {
        console.error('❌ [mentor/request-review] Error:', {
            error: error.message,
            stack: error.stack,
        });
        res.status(500).json({
            error: 'Error al procesar solicitud de revisión',
            details: error.message,
        });
    }
});

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
