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

app.listen(5000, () => console.log('Server ready on port 5000.'));

module.exports = app;
