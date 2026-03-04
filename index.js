const express = require('express');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
require('dotenv').config();

const { setupAuth, isAuthenticated } = require('./auth');
const { pool } = require('./db');

const app = express();
const PORT = 5000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

async function startServer() {
    await setupAuth(app);

    app.get('/', (req, res) => {
        if (!req.isAuthenticated()) {
            return res.sendFile(path.join(__dirname, 'public', 'login.html'));
        }
        res.sendFile(path.join(__dirname, 'public', 'app.html'));
    });

    app.use(express.static('public', { index: false }));

    app.get('/api/me', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
            if (rows[0]) {
                res.json(rows[0]);
            } else {
                res.status(404).json({ error: 'User not found' });
            }
        } catch (error) {
            console.error('Error fetching user:', error);
            res.status(500).json({ error: 'Failed to fetch user' });
        }
    });

    app.post('/api/parse-resume', isAuthenticated, upload.single('resume'), async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        try {
            let text = '';
            if (req.file.mimetype === 'application/pdf') {
                const data = await pdf(req.file.buffer);
                text = data.text;
            } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                const result = await mammoth.extractRawText({ buffer: req.file.buffer });
                text = result.value;
            } else {
                return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or DOCX.' });
            }

            if (text.trim().length < 200) {
                return res.json({ text, warning: 'This file may be scanned or too short. Please paste resume text instead.' });
            }

            res.json({ text });
        } catch (error) {
            console.error('Parse error:', error);
            res.status(500).json({ error: 'Failed to parse resume' });
        }
    });

    app.get('/api/jobs', isAuthenticated, async (req, res) => {
        const { country, what, where, max_salary, remote } = req.query;

        if (!country) {
            return res.status(400).json({ error: 'Country is required' });
        }

        const appId = process.env.ADZUNA_APP_ID;
        const appKey = process.env.ADZUNA_APP_KEY;

        if (!appId || !appKey) {
            return res.status(500).json({ error: 'Adzuna API credentials not configured' });
        }

        const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
        url.searchParams.append('app_id', appId);
        url.searchParams.append('app_key', appKey);
        url.searchParams.append('results_per_page', '50');
        url.searchParams.append('content-type', 'application/json');

        const queryWhat = (what || 'jobs').substring(0, 200);
        url.searchParams.append('what', queryWhat);

        const excludeTerms = 'speech pathologist therapist nurse clinical hospital physician dentist';
        url.searchParams.append('what_exclude', excludeTerms);

        if (where) url.searchParams.append('where', where);
        if (max_salary) url.searchParams.append('salary_min', max_salary);

        if (remote === 'true' && !queryWhat.toLowerCase().includes('remote')) {
            url.searchParams.set('what', queryWhat + ' remote');
        }

        try {
            const response = await fetch(url.toString());
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Adzuna API error:', response.status, errorText);
                return res.status(response.status).json({ error: 'Failed to fetch jobs from Adzuna' });
            }

            const data = await response.json();
            const results = (data.results || []).map(job => ({
                id: job.id,
                title: job.title,
                company: job.company.display_name,
                location: job.location.display_name,
                date: job.created,
                redirect_url: job.redirect_url,
                description: job.description || "",
                salary_min: job.salary_min
            }));

            res.json(results);
        } catch (error) {
            console.error('Server error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.get('/api/saved-jobs', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            const { rows } = await pool.query(
                'SELECT * FROM saved_jobs WHERE user_id = $1 ORDER BY saved_at DESC',
                [userId]
            );
            res.json(rows);
        } catch (error) {
            console.error('Error fetching saved jobs:', error);
            res.status(500).json({ error: 'Failed to fetch saved jobs' });
        }
    });

    app.post('/api/saved-jobs', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            const { job_id, title, company, location, url, salary, description, fit_score } = req.body;
            const { rows } = await pool.query(
                `INSERT INTO saved_jobs (user_id, job_id, title, company, location, url, salary, description, fit_score)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [userId, job_id, title, company, location, url, salary, description, fit_score]
            );
            res.json(rows[0]);
        } catch (error) {
            console.error('Error saving job:', error);
            res.status(500).json({ error: 'Failed to save job' });
        }
    });

    app.delete('/api/saved-jobs/:id', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            await pool.query('DELETE FROM saved_jobs WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
            res.json({ success: true });
        } catch (error) {
            console.error('Error deleting saved job:', error);
            res.status(500).json({ error: 'Failed to delete saved job' });
        }
    });

    app.get('/api/profile', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            const { rows } = await pool.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]);
            res.json(rows[0] || null);
        } catch (error) {
            console.error('Error fetching profile:', error);
            res.status(500).json({ error: 'Failed to fetch profile' });
        }
    });

    app.post('/api/profile', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            const { resume_text, detected_role, detected_skills, seniority, years_exp } = req.body;
            const { rows } = await pool.query(
                `INSERT INTO user_profiles (user_id, resume_text, detected_role, detected_skills, seniority, years_exp)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (user_id) DO UPDATE SET
                   resume_text = EXCLUDED.resume_text,
                   detected_role = EXCLUDED.detected_role,
                   detected_skills = EXCLUDED.detected_skills,
                   seniority = EXCLUDED.seniority,
                   years_exp = EXCLUDED.years_exp,
                   updated_at = NOW()
                 RETURNING *`,
                [userId, resume_text, detected_role, detected_skills, seniority, years_exp]
            );
            res.json(rows[0]);
        } catch (error) {
            console.error('Error saving profile:', error);
            res.status(500).json({ error: 'Failed to save profile' });
        }
    });

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
