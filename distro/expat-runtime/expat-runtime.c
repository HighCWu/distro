// SPDX-License-Identifier: MIT
#include <expat.h>

#include <stdio.h>
#include <string.h>

typedef struct {
	int RootSeen;
	int EntrySeen;
	int RootClosed;
	int InsideEntry;
	int Failed;
	size_t TextLength;
	char Text[16];
} ParseState;

static const char ExpandedRoot[] = "urn:settings\x1f" "config";
static const char ExpandedEntry[] = "urn:settings\x1f" "entry";
static const char ExpectedKey[] = "\xce\xb2";

static int HasAttribute(const XML_Char **Attributes, const char *Name, const char *Value)
{
	for (size_t Index = 0; Attributes[Index] != NULL; Index += 2) {
		if (strcmp(Attributes[Index], Name) == 0 &&
		    strcmp(Attributes[Index + 1], Value) == 0) {
			return 1;
		}
	}
	return 0;
}

static void XMLCALL StartElement(void *UserData, const XML_Char *Name,
				 const XML_Char **Attributes)
{
	ParseState *State = UserData;
	if (strcmp(Name, ExpandedRoot) == 0) {
		if (State->RootSeen || !HasAttribute(Attributes, "version", "3")) {
			State->Failed = 1;
			return;
		}
		State->RootSeen = 1;
	} else if (strcmp(Name, ExpandedEntry) == 0) {
		if (!State->RootSeen || State->EntrySeen || State->InsideEntry ||
		    !HasAttribute(Attributes, "key", ExpectedKey)) {
			State->Failed = 1;
			return;
		}
		State->EntrySeen = 1;
		State->InsideEntry = 1;
	} else {
		State->Failed = 1;
	}
}

static void XMLCALL EndElement(void *UserData, const XML_Char *Name)
{
	ParseState *State = UserData;
	if (strcmp(Name, ExpandedEntry) == 0 && State->InsideEntry) {
		State->InsideEntry = 0;
	} else if (strcmp(Name, ExpandedRoot) == 0 && State->RootSeen && !State->RootClosed) {
		State->RootClosed = 1;
	} else {
		State->Failed = 1;
	}
}

static void XMLCALL CharacterData(void *UserData, const XML_Char *Data, int Length)
{
	ParseState *State = UserData;
	if (!State->InsideEntry || Length <= 0) return;
	if ((size_t)Length > sizeof(State->Text) - State->TextLength - 1) {
		State->Failed = 1;
		return;
	}
	memcpy(State->Text + State->TextLength, Data, (size_t)Length);
	State->TextLength += (size_t)Length;
	State->Text[State->TextLength] = '\0';
}

static int ParseStreamedDocument(void)
{
	static const char Document[] =
		"<?xml version=\"1.0\"?>"
		"<s:config xmlns:s=\"urn:settings\" version=\"3\">"
		"<s:entry key=\"\xce"
		"\xb2\">A&amp;B</s:entry>"
		"</s:config>";
	ParseState State = {0};
	XML_Parser Parser = XML_ParserCreateNS(NULL, '\x1f');
	if (!Parser) return 1;

	XML_SetUserData(Parser, &State);
	XML_SetElementHandler(Parser, StartElement, EndElement);
	XML_SetCharacterDataHandler(Parser, CharacterData);

	size_t Utf8LeadByte = 0;
	while (Utf8LeadByte < sizeof(Document) - 1 &&
	       (unsigned char)Document[Utf8LeadByte] != 0xce) {
		++Utf8LeadByte;
	}
	if (Utf8LeadByte == sizeof(Document) - 1) {
		XML_ParserFree(Parser);
		return 2;
	}

	const size_t FirstLength = Utf8LeadByte + 1;
	const size_t Remaining = sizeof(Document) - 1 - FirstLength;
	const size_t SecondLength = Remaining < 5 ? Remaining : 5;
	if (XML_Parse(Parser, Document, (int)FirstLength, XML_FALSE) != XML_STATUS_OK ||
	    XML_Parse(Parser, Document + FirstLength, (int)SecondLength, XML_FALSE) != XML_STATUS_OK ||
	    XML_Parse(Parser, Document + FirstLength + SecondLength,
		      (int)(Remaining - SecondLength), XML_TRUE) != XML_STATUS_OK) {
		XML_ParserFree(Parser);
		return 3;
	}

	XML_ParserFree(Parser);
	if (State.Failed || !State.RootSeen || !State.EntrySeen || !State.RootClosed ||
	    State.InsideEntry || strcmp(State.Text, "A&B") != 0) {
		return 4;
	}
	return 0;
}

static int CheckMalformedInputDiagnostic(void)
{
	static const char Document[] = "<root><entry></root>";
	XML_Parser Parser = XML_ParserCreate(NULL);
	if (!Parser) return 1;

	const enum XML_Status Status = XML_Parse(Parser, Document, sizeof(Document) - 1, XML_TRUE);
	const enum XML_Error Error = XML_GetErrorCode(Parser);
	const XML_LChar *Diagnostic = XML_ErrorString(Error);
	const int HasDiagnostic = Diagnostic != NULL && Diagnostic[0] != '\0';
	const XML_Size Line = XML_GetCurrentLineNumber(Parser);
	XML_ParserFree(Parser);
	if (Status != XML_STATUS_ERROR || Error != XML_ERROR_TAG_MISMATCH ||
	    !HasDiagnostic || Line != 1) {
		return 2;
	}
	return 0;
}

int main(void)
{
	if (ParseStreamedDocument() != 0 || CheckMalformedInputDiagnostic() != 0) {
		fprintf(stderr, "Expat streaming parse or error diagnostic check failed\n");
		return 1;
	}
	puts("expat-runtime: streamed UTF-8 namespace/attribute parse and malformed-input diagnostic verified");
	return 0;
}
