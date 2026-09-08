# Scribe

**Scribe** is a full-stack social reading and story publishing platform where readers can discover and read stories, while writers can create, manage, and publish their own content.

The project is being rebuilt with a modern, production-oriented architecture using **React, Node.js, TypeScript, PostgreSQL, Prisma, and Docker**.

## ✨ Features

### 📖 Readers

* Browse and discover stories
* Filter stories by genre
* Read stories and chapters
* Track reading progress
* Save stories for later
* Like, rate, and comment on stories

### ✍️ Writers

* Create and manage stories
* Write and edit chapters
* Save stories as drafts
* Publish completed chapters
* Manage story information, genres, and covers
* View basic story analytics

### 🔐 Authentication & Authorization

* User registration and login
* JWT-based authentication
* Access and refresh tokens
* Protected API routes
* Role-based authorization
* Secure password hashing

### 🛡️ Platform

* Input validation
* Centralized error handling
* API pagination
* Search and filtering
* Database migrations
* API documentation
* Dockerized development environment

## 🏗️ Architecture

```text
                    ┌──────────────────┐
                    │   React Client   │
                    │  TypeScript/Vite │
                    └────────┬─────────┘
                             │
                           REST API
                             │
                    ┌────────▼─────────┐
                    │   Node.js API    │
                    │ TypeScript/Express│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │      Prisma      │
                    │       ORM        │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   PostgreSQL     │
                    └──────────────────┘
```

## 🛠️ Tech Stack

### Frontend

* React
* TypeScript
* Vite
* Tailwind CSS
* React Router
* Axios

### Backend

* Node.js
* TypeScript
* Express
* Prisma
* Zod
* JWT
* bcrypt

### Database & Infrastructure

* PostgreSQL
* Docker
* Docker Compose

### Development

* ESLint
* Prettier
* Jest
* Swagger / OpenAPI
* Git & GitHub

## 📁 Project Structure

```text
scribe/
├── frontend/
│   ├── src/
│   ├── public/
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── repositories/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── validators/
│   │   └── app.ts
│   │
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── seed.ts
│   │
│   └── package.json
│
├── docker-compose.yml
├── .env.example
└── README.md
```

## 🚀 Getting Started

### Prerequisites

Make sure you have the following installed:

* Node.js 20+
* npm
* Docker
* Docker Compose
* Git

### 1. Clone the repository

```bash
git clone <your-repository-url>
cd scribe
```

### 2. Configure environment variables

Create environment files based on the provided examples:

```bash
cp backend/.env.example backend/.env
```

Update the required values in `.env`.

### 3. Start PostgreSQL

```bash
docker compose up -d postgres
```

### 4. Install backend dependencies

```bash
cd backend
npm install
```

### 5. Run database migrations

```bash
npx prisma migrate dev
```

### 6. Start the backend

```bash
npm run dev
```

### 7. Start the frontend

Open another terminal:

```bash
cd frontend
npm install
npm run dev
```

The application will then be available through the local Vite development server.

## 🔌 API

The backend exposes a REST API.

### Authentication

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
```

### Users

```text
GET /api/user
GET /api/users/:id
```

### Stories

```text
POST   /api/stories
GET    /api/stories
GET    /api/stories/:id
PATCH  /api/stories/:id
DELETE /api/stories/:id
```

### Chapters

```text
POST   /api/stories/:storyId/chapters
GET    /api/stories/:storyId/chapters
GET    /api/chapters/:id
PATCH  /api/chapters/:id
DELETE /api/chapters/:id
```

> API endpoints may evolve as the project develops.

## 🗄️ Database

Scribe uses **PostgreSQL** as its primary relational database.

Prisma is used for:

* Schema management
* Type-safe database queries
* Database migrations
* Seeding development data

The goal is to keep the application's core data in a single relational database rather than splitting related functionality across multiple database systems.

## 🐳 Docker

Docker Compose is used to provide a consistent local development environment.

```bash
docker compose up -d
```

To stop the environment:

```bash
docker compose down
```

## 🧪 Testing

Run backend tests with:

```bash
npm test
```

For test coverage:

```bash
npm run test:coverage
```

## 📌 Development Roadmap

### Phase 1 — Foundation

* [x] Project setup
* [ ] Docker development environment
* [ ] PostgreSQL setup
* [ ] Prisma configuration
* [ ] API health check
* [ ] Error handling
* [ ] Logging

### Phase 2 — Authentication

* [ ] User registration
* [ ] Login
* [ ] JWT authentication
* [ ] Refresh tokens
* [ ] Logout
* [ ] Role-based authorization

### Phase 3 — Core Platform

* [ ] Story management
* [ ] Chapter management
* [ ] Genres
* [ ] Draft and publishing workflow
* [ ] Reader experience
* [ ] Author profiles

### Phase 4 — Social Features

* [ ] Likes
* [ ] Comments
* [ ] Ratings
* [ ] Bookmarks
* [ ] Reading history
* [ ] Reading progress

### Phase 5 — Platform Features

* [ ] Search
* [ ] Recommendations
* [ ] Author analytics
* [ ] Content moderation
* [ ] Badges and achievements
* [ ] Writing challenges
* [ ] Book clubs

### Phase 6 — Production Readiness

* [ ] Comprehensive test coverage
* [ ] API documentation
* [ ] CI/CD
* [ ] Production Docker setup
* [ ] Performance optimization
* [ ] Security hardening
* [ ] Monitoring and logging

## 🎯 Project Goals

Scribe is being developed with a focus on:

* Clean and maintainable architecture
* Type-safe development
* Secure authentication and authorization
* Scalable API design
* Relational database design
* Containerized development
* Automated testing
* Production-ready engineering practices

## 📄 License

This project is currently for personal learning and portfolio development.
