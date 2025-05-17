# GitHub Copilot Instructions for Clip Editing UI

## Project Overview

This is an Electron application for editing video clips. The UI provides an interface for users to select videos, edit clips, apply various modifications, and export the edited videos.

## Tech Stack

- Electron
- React
- TypeScript
- Node.js

## Code Style Preferences

- Use TypeScript for type safety
- Use React hooks for state management
- Prefer async/await over promises with .then()
- Use shadcn components in `src/components/ui` when applicable. Prefer shadcn components over creating custom ones.
- Always edit a file directly, do not make copies of files to edit. There is no need for backups.
- NEVER put the base layout in any page.

## Preferred Practices

- Write modular, reusable components
- Include appropriate error handling
- Add comments for complex logic
- Follow the principle of least privilege for permissions
- Implement proper validation for user inputs
- Use descriptive variable and function names
- All ipc code should be in the `src/helpers/ipc` directory.

## Documentation

- Include JSDoc comments for functions and components when applicable, it is not needed for simple functions
- Do not make use of excessive comments, the code should be self-explanatory. Only include comments when necessary.
