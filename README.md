# Database Query Troubleshooter

An interactive React application that helps developers diagnose and fix slow database queries across different database systems.

## Features

- **Multi-Database Support**: PostgreSQL, MySQL, SQL Server, Oracle
- **Step-by-Step Guidance**: Interactive troubleshooting workflows
- **Copy-to-Clipboard**: Easy SQL query copying
- **Responsive Design**: Works on desktop and mobile
- **Modern Tech Stack**: React 18, TypeScript, Vite, Tailwind CSS

## Live Demo

🌐 **[View Live Application](https://yourusername.github.io/sql-stuff/)**

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

1. **Push to GitHub**: Commit and push your code to the `main` branch
2. **Enable GitHub Pages**: Go to your repository Settings → Pages
3. **Select Source**: Choose "GitHub Actions" as the source
4. **Automatic Deployment**: The GitHub Action will automatically deploy on every push to `main`

### Manual Deployment

```bash
# Deploy to GitHub Pages
npm run deploy
```

## Project Structure

```
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
