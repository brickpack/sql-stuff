# Database Query Troubleshooter

An interactive React application that helps developers diagnose and fix slow database queries across different database systems.

## Features

- **Multi-Database Support**: PostgreSQL, MySQL, SQL Server, Oracle, Snowflake
- **Step-by-Step Guidance**: Interactive troubleshooting workflows
- **Copy-to-Clipboard**: Easy SQL query copying
- **Responsive Design**: Works on desktop and mobile
- **Modern Tech Stack**: React 18, TypeScript, Vite, Tailwind CSS

## Live Demo

🌐 **[View Live Application](https://brickpack.github.io/sql-stuff/)**

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment to GitHub Pages

### Automatic Deployment (Recommended)

1. **Enable GitHub Pages**: Go to your repository Settings → Pages
2. **Select Source**: Choose "GitHub Actions" as the source
3. **Push to GitHub**: Commit and push your code to the `main` branch
4. **Automatic Deployment**: The GitHub Action will automatically deploy on every push to `main`

### Manual Deployment

```bash
# Deploy to GitHub Pages
npm run deploy
```

## CLI Troubleshooter (Python)

In addition to the web app, two Python scripts let you run the same troubleshooting steps directly against a live database from the command line.

### Prerequisites

Install the driver for your database:

| Database   | Package                                      |
|------------|----------------------------------------------|
| PostgreSQL | `pip install psycopg2`                       |
| SQL Server | `pip install pyodbc`                         |
| MySQL      | `pip install mysql-connector-python`         |
| Oracle     | `pip install cx_Oracle`                      |
| Snowflake  | `pip install snowflake-connector-python`     |

### Step 1 — Run the interactive troubleshooter

```bash
python db_troubleshooter.py
```

The script will prompt you to:

1. Select a database type
2. Enter connection details (host, port, database name, username, password)
3. Step through each diagnostic check — for each step you can:
   - Run the diagnostic SQL against your live database
   - Answer yes/no checks (flagged issues display actionable advice)
   - Optionally apply fix SQL (default is **No** — destructive actions are never applied automatically)
   - Press `s` to skip a step or `q` to quit early

Results are saved to `troubleshoot_results.json` in the current directory.

### Step 2 — Generate the HTML report

```bash
python results_viewer.py
```

Reads `troubleshoot_results.json` and writes `troubleshoot_report.html`, then opens it in your default browser. To read a different results file:

```bash
python results_viewer.py /path/to/troubleshoot_results.json
```

The report includes:

- **Action Items** — a consolidated list of all flagged checks with advice, grouped by step
- **Step-by-step results** — collapsible cards with query output tables, check answers, and applied actions

## Project Structure

```text
├── src/
│   ├── main.tsx              # React app entry point
│   └── DBTroubleshooter.tsx # Main component
├── .github/workflows/
│   └── deploy.yml            # GitHub Actions deployment
├── dist/                     # Production build output
└── package.json              # Dependencies and scripts
```

## Technologies Used

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Styling
- **Lucide React** - Icons
- **GitHub Pages** - Hosting
- **GitHub Actions** - CI/CD

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `npm run dev`
5. Submit a pull request

## License

MIT License - feel free to use this project for your own database troubleshooting needs!
