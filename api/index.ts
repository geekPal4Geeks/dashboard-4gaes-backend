require('dotenv').config();

const express = require('express');
const app = express();
const { sql } = require('@vercel/postgres');
const { Client, LogLevel } = require('@notionhq/client');
const cors = require('cors');

const bodyParser = require('body-parser');
const path = require('path');

// Create application/x-www-form-urlencoded parser
const urlencodedParser = bodyParser.urlencoded({ extended: false });
app.use(express.json());
app.use(cors());

// Configuración del cliente de Notion
const notion = new Client({
    auth: process.env.NOTION_TOKEN,
    logLevel: LogLevel.DEBUG
});

app.use(express.static('public'));

app.get('/', function (req, res) {
    res.sendFile(path.join(__dirname, '..', 'components', 'home.htm'));
});

// Endpoint para obtener información de la cohorte
app.post('/api/cohort-info', async (req, res) => {
    try {
        const { cohortId } = req.body;

        if (!cohortId) {
            return res.status(400).json({ error: 'Se requiere el ID de la cohorte' });
        }

        const response = await notion.databases.query({
            database_id: process.env.NOTION_DATABASE_ID,
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

        // Devolvemos solo la información de la cohorte
        res.status(200).json(response.results[0]);
    } catch (error) {
        console.error('Error obteniendo información de Notion:', error);
        res.status(500).json({ error: 'Error al obtener información de la cohorte' });
    }
});

// endpoint para obtener información de un estudiante específico
app.post('/api/student-info', async (req, res) => {
    try {
        const { studentId } = req.body;

        if (!studentId) {
            return res.status(400).json({ error: 'Se requiere el ID del estudiante' });
        }

        const studentResponse = await notion.pages.retrieve({
            page_id: studentId
        });

        if (!studentResponse) {
            return res.status(404).json({ error: 'Estudiante no encontrado' });
        }

        res.status(200).json(studentResponse);
    } catch (error) {
        console.error('Error obteniendo información del estudiante:', error);
        res.status(500).json({ error: 'Error al obtener información del estudiante' });
    }
});

// Endpoint para actualizar una propiedad de un estudiante
// Endpoint para actualizar una propiedad de un estudiante
app.put('/api/update-student-property', async (req, res) => {
    try {
        const { studentId, propertyName, propertyValue } = req.body;

        if (!studentId || !propertyName || propertyValue === undefined) {
            return res.status(400).json({
                error: 'Se requieren studentId, propertyName y propertyValue'
            });
        }

        // Determinar el tipo de propiedad basado en el nombre y formatear el valor
        let propertyUpdate;

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

        if (numericProperties.includes(propertyName)) {
            // Asegurarse de que el valor sea un número (o null si es vacío)
            const numericValue = propertyValue === '' || propertyValue === null ? null : Number(propertyValue);
            if (isNaN(numericValue) && numericValue !== null) {
                 return res.status(400).json({
                    error: `El valor para ${propertyName} debe ser un número.`
                });
            }
            propertyUpdate = {
                [propertyName]: {
                    number: numericValue
                }
            };
        }
        // Propiedad multi-select
        else if (propertyName === 'Technical specialties') {
            // El frontend ya envía un array de objetos { name: '...' }
            propertyUpdate = {
                [propertyName]: {
                    multi_select: propertyValue
                }
            };
        }
        // Propiedad checkbox
        else if (propertyName === 'Recomendado para TA') {
            propertyUpdate = {
                [propertyName]: {
                    checkbox: Boolean(propertyValue)
                }
            };
        }
        // Propiedades de texto enriquecido (por defecto para otros tipos)
        else {
            propertyUpdate = {
                [propertyName]: {
                    rich_text: [
                        {
                            text: {
                                content: propertyValue.toString()
                            }
                        }
                    ]
                }
            };
        }


        const updateResponse = await notion.pages.update({
            page_id: studentId,
            properties: propertyUpdate
        });

        if (!updateResponse) {
            // Dependiendo de la API de Notion, un 400 podría no lanzar un error, manejarlo aquí
             return res.status(400).json({ error: 'Error al actualizar la propiedad en Notion (respuesta vacía)' });
        }


        res.status(200).json(updateResponse);
    } catch (error) {
        console.error('Error actualizando propiedad del estudiante:', error);
        // Capturar errores específicos de la API de Notion si es posible
        if (error.code === 'validation_error') {
             res.status(400).json({ error: `Error de validación en Notion: ${error.message}` });
        } else {
            res.status(500).json({ error: 'Error interno al actualizar la propiedad del estudiante' });
        }
    }
});

// Endpoint para crear un comentario en la ficha de un estudiante
app.post('/api/create-student-comment', async (req, res) => {
    try {
        const { studentId, comment } = req.body;

        if (!studentId || !comment) {
            return res.status(400).json({
                error: 'Se requieren studentId y comment'
            });
        }

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

        res.status(200).json(response);
    } catch (error) {
        console.error('Error creando comentario:', error);
        res.status(500).json({ error: 'Error al crear el comentario' });
    }
});

app.listen(5000, () => console.log('Server ready on port 5000.'));

module.exports = app;
